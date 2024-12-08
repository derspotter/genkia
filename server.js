const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const { exec } = require('child_process');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const fs = require('fs').promises;
const { createWriteStream, statSync } = require('fs');

const app = express();

// Security middleware
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Add this line to use the forwarded IP if available
  trustProxy: true
});
app.use(limiter);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI);

// Simplified VerifiedUser model
const verifiedUserSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  verifiedAt: { type: Date, default: Date.now }
});
const VerifiedUser = mongoose.model('VerifiedUser', verifiedUserSchema);

// Define Token schema
const tokenSchema = new mongoose.Schema({
  email: String,
  token: String,
  createdAt: { type: Date, expires: '24h', default: Date.now }
});

const Token = mongoose.model('Token', tokenSchema);

// Email configuration
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false, // Use STARTTLS
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    // Do not fail on invalid certs
    // rejectUnauthorized: false,
    // Ignore SSL/TLS version mismatch
    // minVersion: 'TLSv1'
  }
});

// Check verification status and send verification email if needed
// Add this route to your server.js file
app.post('/api/check-verification', async (req, res) => {
  console.log('Received verification check request');
  const { email } = req.body;
  
//  if (!email || !email.endsWith('@wzb.eu')) {
//    console.log('Invalid email:', email);
//    return res.status(400).json({ message: 'Invalid email address' });
//  }

  function isValidEmail(email) {
    // Use a regular expression to validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  if (!email || !isValidEmail(email)) {
    console.log('Invalid email:', email);
    return res.status(400).json({ message: 'Invalid email address' });
  }

  try {
    console.log('Checking if user is verified:', email);
    const verifiedUser = await VerifiedUser.findOne({ email });
    if (verifiedUser) {
      console.log('User is verified:', email);
      return res.json({ verified: true });
    }

    console.log('User not verified, sending verification email:', email);
    // Email not verified, send verification email
    const token = crypto.randomBytes(32).toString('hex');
    await Token.create({ email, token });

    const verificationLink = `https://genkia.de/api/verify/${token}`;
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Verify Your Email',
      text: `Please click on the following link to verify your email: ${verificationLink}`
    };

    await transporter.sendMail(mailOptions);
    console.log('Verification email sent to:', email);
    res.json({ verified: false, message: 'Verification email sent' });
  } catch (error) {
    console.error(`Error in check-verification:`, error);
    res.status(500).json({ message: 'Error checking verification status', error: error.message });
  }

});

// Verification route
app.get('/api/verify/:token', async (req, res) => {
  const { token } = req.params;
  
  try {
    const tokenDoc = await Token.findOne({ token });
    if (!tokenDoc) {
      return res.status(400).json({ message: 'Invalid or expired verification link.' });
    }

    await VerifiedUser.findOneAndUpdate(
      { email: tokenDoc.email },
      { email: tokenDoc.email },
      { upsert: true, new: true }
    );

    await Token.deleteOne({ token });

    res.send(`
      <html>
        <body>
          <h1>Email Verified</h1>
          <p>Your email (${tokenDoc.email}) has been verified. You can now upload your audio file.</p>
          <p>Please return to <a href="https://genkia.de">https://genkia.de</a> to upload your file.</p>
        </body>
      </html>
    `);

  } catch (error) {
    console.error(`Error: ${error}`);
    res.status(500).json({ message: 'An error occurred during verification', error: error.message });
  }
});

const { spawn } = require('child_process');

// Temporary storage for chunks
const uploadChunks = new Map();

const SPEED_WINDOW = 3; // Number of chunks to average speed over

app.post('/api/upload-chunk', express.raw({ limit: '10mb' }), (req, res) => {
  const fileName = req.headers['x-file-name'];
  const fileExtension = path.extname(fileName).toLowerCase();
  const email = req.headers['x-email'];
  const chunkNumber = parseInt(req.headers['x-chunk-number']);
  const totalChunks = parseInt(req.headers['x-total-chunks']);
  const buffer = req.body;
  const fileId = req.headers['x-file-id'];

  console.log(`\n=== Processing chunk ${chunkNumber + 1}/${totalChunks} ===`);
  console.log(`File: ${fileName}`);
  console.log(`Size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  try {
    if (!uploadChunks.has(fileId)) {
      uploadChunks.set(fileId, {
        chunks: new Map(),
        startTime: Date.now(),
        totalBytes: 0,
        fileName,
        chunkTimes: new Map() // Track timing of recent chunks
      });
    }

    const upload = uploadChunks.get(fileId);
    const now = Date.now();
    
    upload.chunks.set(chunkNumber, buffer);
    upload.totalBytes += buffer.length;
    upload.chunkTimes.set(chunkNumber, now);

    // Calculate speed using recent chunks
    const startChunk = Math.max(0, chunkNumber - SPEED_WINDOW + 1);
    const recentTime = now - (upload.chunkTimes.get(startChunk) || upload.startTime);
    const recentBytes = Array.from(upload.chunks.entries())
      .filter(([num]) => num >= startChunk && num <= chunkNumber)
      .reduce((sum, [_, chunk]) => sum + chunk.length, 0);
    
    const speed = recentTime > 0 ? (recentBytes / 1024 / 1024) / (recentTime / 1000) : 0;
    const progress = Math.round((upload.chunks.size / totalChunks) * 100);

    console.log(`Progress: ${progress}%`);
    console.log(`Speed: ${speed.toFixed(2)} MB/s`);

    if (progress === 100) {
      console.log('Upload complete, starting processing...');
      setImmediate(async () => {
        try {
          await combineAndProcessFile(fileId, email);
          console.log(`Processing completed for file ${fileName}`);
        } catch (error) {
          console.error('Processing error:', error);
        }
      });
    }

    res.json({ progress, speed: speed.toFixed(2), chunk: chunkNumber, total: totalChunks });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function combineAndProcessFile(fileId, email, progressCallback) {
  // ... existing setup code ...

  try {
      progressCallback('Writing file', 0);
      const writeStream = createWriteStream(finalPath);
      let bytesWritten = 0;
      const totalBytes = upload.chunks.size * upload.chunks.get(0).length;

      for (let i = 0; i < upload.totalChunks; i++) {
          const chunk = upload.chunks.get(i);
          if (!chunk) throw new Error(`Missing chunk ${i}`);
          
          await new Promise((resolve, reject) => {
              writeStream.write(chunk, (error) => {
                  if (error) reject(error);
                  else {
                      bytesWritten += chunk.length;
                      progressCallback('Writing file', 
                          Math.round((bytesWritten / totalBytes) * 100));
                      resolve();
                  }
              });
          });
      }

      progressCallback('Starting rsync', 50);

      // Initialize rsync with progress tracking
      const rsync = spawn('rsync', [
          '-avz',
          '--progress',
          '-e', `ssh -o StrictHostKeyChecking=accept-new -i /app/ssh/kkey -p ${process.env.SSH_PORT || '22'}`,
          finalPath,
          metadataPath,
          `jay@${process.env.SSH_HOST}:transcribe/audio/`
      ]);

      rsync.stdout.on('data', (data) => {
          const output = data.toString();
          if (output.includes('%')) {
              const match = output.match(/(\d+)%/);
              if (match) {
                  const rsyncProgress = parseInt(match[1]);
                  progressCallback('Transferring', rsyncProgress);
              }
          }
          console.log('rsync:', output.trim());
      });

      // ... rest of the rsync code ...
  } catch (error) {
      console.error('Error in processing:', error);
      throw error;
  }
}

async function combineAndProcessFile(fileId, email) {
  const upload = uploadChunks.get(fileId);
  const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
  const finalPath = path.join('/app/uploads', `${fileId}-${upload.fileName}`);
  let rsyncSuccess = false;

  try {
      // Write file
      const writeStream = createWriteStream(finalPath);
      
      for (let i = 0; i < upload.totalChunks; i++) {
          const chunk = upload.chunks.get(i);
          if (!chunk) throw new Error(`Missing chunk ${i}`);
          await new Promise((resolve, reject) => {
              writeStream.write(chunk, (error) => {
                  if (error) reject(error);
                  else resolve();
              });
          });
      }

      await new Promise((resolve, reject) => {
          writeStream.end((error) => {
              if (error) reject(error);
              else resolve();
          });
      });

      console.log('File written successfully to:', finalPath);
      
      // Clean up chunks early to free memory
      uploadChunks.delete(fileId);

      // Create and write metadata
      const jobId = crypto.randomBytes(16).toString('hex');
      const metadataPath = `/app/uploads/${jobId}.json`;
      const metadata = {
          jobId,
          email,
          audioFilename: path.basename(finalPath),
          originalFilename: upload.fileName,
          fileSize: statSync(finalPath).size,
          uploadTime: new Date().toISOString()
      };

      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
      console.log('Metadata written to:', metadataPath);

      // Try rsync
      console.log('Starting rsync transfer...');
      await new Promise((resolve, reject) => {
          const rsync = spawn('rsync', [
              '-avz',
              '--progress',
              '-e', `ssh -o StrictHostKeyChecking=accept-new -i /app/ssh/kkey -p ${process.env.SSH_PORT || '22'}`,
              finalPath,
              metadataPath,
              `jay@${process.env.SSH_HOST}:transcribe/audio/`
          ]);

          rsync.stdout.on('data', (data) => {
              console.log('rsync stdout:', data.toString());
          });

          rsync.stderr.on('data', (data) => {
              console.error('rsync stderr:', data.toString());
          });

          rsync.on('close', (code) => {
              if (code === 0) {
                  rsyncSuccess = true;
                  resolve();
              } else {
                  reject(new Error(`rsync failed with code ${code}`));
              }
          });
      });

      // Only delete local files if rsync succeeded
      if (rsyncSuccess) {
          await Promise.all([
              fs.unlink(finalPath),
              fs.unlink(metadataPath)
          ]);
          console.log('Local files cleaned up after successful transfer');
      } else {
          console.log('Keeping local files due to transfer failure');
      }

  } catch (error) {
      console.error('Error in processing:', error);
      // Don't delete files if rsync failed - they might be needed for retry
      if (!rsyncSuccess) {
          console.log('Keeping files for potential retry');
      }
      throw error; // Rethrow for background handling
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'An unexpected error occurred' });
});

// Start the server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
server.timeout = 3600000;
server.keepAliveTimeout = 120000;
