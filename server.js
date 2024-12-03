const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const { exec } = require('child_process');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const fs = require('fs');
const bodyParser = require('body-parser');
const app = express();

// For text fields
app.use(bodyParser.json({ limit: '1mb' })); // Only need small limit for JSON
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

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

const upload = multer({ 
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, '/app/uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
}),
limits: { 
    fileSize: 500 * 1024 * 1024, // 500MB in bytes
    fieldSize: 500 * 1024 * 1024,
    fields: 5,   // Limit number of non-file fields
    parts: 6     // Total fields + files
},
  fileFilter: (req, file, cb) => {
    console.log('Received file:', file);
    const filetypes = /mp3|wav|m4a|ogg|flac|aac|opus/;
    const mimetypes = /audio\/(mp3|wav|x-wav|m4a|x-m4a|ogg|flac|aac|mpeg|mp4)|video\/(ogg|mp4)/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = mimetypes.test(file.mimetype);
    
    console.log('Mimetype check:', mimetype);
    console.log('Extension check:', extname);
    console.log('File mimetype:', file.mimetype);
    console.log('File extension:', path.extname(file.originalname).toLowerCase());
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error(`Error: Only audio files are allowed (mp3, wav, m4a, ogg, flac, aac). Received mimetype: ${file.mimetype}, extension: ${path.extname(file.originalname)}`));
    
  }
}).single('file');

const { spawn } = require('child_process');

app.post('/api/upload', async (req, res) => {
    console.log('Upload request received');
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendSSE = (type, data) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    };

    try {
      await new Promise((resolve, reject) => {
        let uploadedBytes = 0;
        let lastProgress = 0;

        req.on('data', (chunk) => {
          console.log('Chunk size:', chunk.length, 'bytes');
          // Keep track of our last sent progress percentage
          let lastProgress = req.uploadProgress || 0;
          // Add the new chunk to our total
          uploadedBytes += chunk.length;
          // Calculate current progress percentage
          const currentProgress = Math.round((uploadedBytes / req.headers['content-length']) * 100);
          // Only send an update if we've moved to a new percentage point
          if (currentProgress > lastProgress) {
            sendSSE('upload_progress', { progress: currentProgress });
            // Store the last progress we sent on the request object
            req.uploadProgress = currentProgress;
          }
        });

        upload(req, res, (err) => {
          if (err) {
            sendSSE('error', { message: err.message });
            reject(err);
            return;
          }
          resolve();
        });
      });


      if (!req.file) {
        throw new Error('No file uploaded');
      }

      console.log('File uploaded successfully:', req.file.filename);

    const { email } = req.body;
    // Email validation commented out as per your code
    // if (!email || !email.endsWith('@wzb.eu')) {
    //   throw new Error('Invalid email address');
    // }

    const verifiedUser = await VerifiedUser.findOne({ email });
    if (!verifiedUser) {
      throw new Error('Email not verified. Please verify your email before uploading.');
    }

    console.log('User verified, proceeding with file processing');

    const jobId = crypto.randomBytes(16).toString('hex');
    console.log('Generated job ID:', jobId);

    const metadataPath = `/app/uploads/${jobId}.json`;
    const metadata = { jobId, email, audioFilename: req.file.filename, originalFilename: req.file.originalname };
    await fs.promises.writeFile(metadataPath, JSON.stringify(metadata));
    console.log('Metadata file created:', metadataPath);

    const rsyncArgs = [
      '-avz',
      '--progress',
      '-e', `ssh -o StrictHostKeyChecking=accept-new -i /app/ssh/kkey -p ${process.env.SSH_PORT || '22'}`,
      `/app/uploads/${req.file.filename}`,
      metadataPath,
      `jay@${process.env.SSH_HOST}:transcribe/audio/`
    ];
    
    console.log('Executing rsync command:', rsyncArgs.join(' '));
    
    const rsync = spawn('rsync', rsyncArgs);

    rsync.stdout.on('data', (data) => {
      const output = data.toString();
      const match = output.match(/(\d+)%/);
      if (match) {
        const progress = parseInt(match[1], 10);
        sendSSE('rsync_progress', { progress });
      }
    });

    rsync.stderr.on('data', (data) => {
      console.error(`rsync stderr: ${data}`);
    });

    await new Promise((resolve, reject) => {
      rsync.on('close', async (code) => {
        console.log(`rsync process exited with code ${code}`);

        if (code === 0) {
          console.log('rsync completed successfully');

          try {
            await Promise.all([
              fs.promises.unlink(req.file.path),
              fs.promises.unlink(metadataPath)
            ]);
            console.log('Temporary files deleted successfully');
          } catch (cleanupError) {
            console.error(`Cleanup error:`, cleanupError);
          }

          sendSSE('rsync_complete', { jobId });
          resolve();
        } else {
          console.error('rsync failed');
          reject(new Error('Error transferring file to home PC'));
        }
      });
    });

    } catch (error) {
      console.error('Upload error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      sendSSE('error', { message: error.message });
    }
});

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
