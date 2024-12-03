console.log('app.js is loading');

document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM fully loaded and parsed');

  if (typeof window.van === 'undefined') {
    console.error('VanJS is not loaded. Please check if the VanJS script is included correctly.');
    return;
  }

  const van = window.van;
  console.log('VanJS version:', van.version);

  const { div, form, input, label, button, p, progress } = van.tags;

  const AudioTranscriptionApp = () => {
    console.log('AudioTranscriptionApp function called');
    const email = van.state('');
    const file = van.state(null);
    const status = van.state('');
    const isVerified = van.state(false);
    const jobId = van.state(null);
    const uploadProgress = van.state(0);

    const checkVerification = async () => {
      console.log('Checking verification for:', email.val);
      status.val = 'Checking verification...';
      try {
        const response = await fetch('/api/check-verification', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email: email.val }),
        });
        
        const data = await response.json();

        if (!response.ok) {
          isVerified.val = false;
          if (response.status === 400) {
            // Handle 400 Bad Request (including invalid email)
            status.val = data.message;
          } else {
            // Handle other error statuses
            throw new Error(`HTTP error! status: ${response.status}`);
          }
        } else if (data.verified) {
          console.log('Email verified');
          isVerified.val = true;
          status.val = 'Email verified. You can now upload your file.';
        } else {
          isVerified.val = false;
          console.log('Email not verified:', data.message);
          status.val = 'Verification email sent. Please check your inbox and click the verification link.';
        }
      } catch (error) {
        console.error('Error checking verification:', error);
        status.val = `Error checking verification status: ${error.message}. Please try again.`;
      }
    };

const handleUpload = async (e) => {
    e.preventDefault();
    status.val = 'Uploading...';
    jobId.val = null;
    uploadProgress.val = 0;

    const formData = new FormData();
    formData.append('email', email.val);
    formData.append('file', file.val);

    const maxRetries = 3;
    let attempt = 0;

    const uploadWithTimeout = async () => {
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), 3600000);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
                signal: abortController.signal,
                keepalive: true
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n\n');
                
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    
                    const eventData = JSON.parse(line.slice(6));
                    switch (eventData.type) {
                        case 'upload_progress':
                            uploadProgress.val = eventData.progress;
                            status.val = 'Uploading to server';
                            break;
                        case 'rsync_progress':
                            status.val = 'Uploading to GPU';
                            uploadProgress.val = eventData.progress;
                            break;
                        case 'rsync_complete':
                            status.val = 'Upload complete. Transcription process started.';
                            jobId.val = eventData.jobId;
                            return true;
                        case 'error':
                            throw new Error(eventData.message);
                    }
                }
            }
            return true;
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Upload timed out');
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    };

    while (attempt < maxRetries) {
        try {
            await uploadWithTimeout();
            break;
        } catch (error) {
            attempt++;
            console.error(`Upload attempt ${attempt} failed:`, error);
            
            if (attempt === maxRetries) {
                status.val = `Upload failed after ${maxRetries} attempts: ${error.message}`;
                return;
            }
            
            status.val = `Retrying upload (attempt ${attempt + 1}/${maxRetries})...`;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
};

return div(
  form({ onsubmit: (e) => e.preventDefault() },
    div(
      label({ for: 'email' }, 'Email:'),
      input({
        type: 'email',
        id: 'email',
        value: email.val,
        oninput: (e) => email.val = e.target.value,
        required: true
      })
    ),
    button({ onclick: checkVerification, type: 'button' }, 'Verify Email')
  ),

  p(() => status.val),

  () => isVerified.val && div(
      label({ for: 'file' }, 'Audio File:'),
        input({
          type: 'file',
          id: 'file',
          accept: 'audio/*',
          onchange: (e) => file.val = e.target.files[0],
          required: true
        }),
        button({ onclick: handleUpload, type: 'button' }, 'Upload and Transcribe'),
        () => uploadProgress.val > 0 && div(
          progress({ value: uploadProgress.val, max: 100 }),
          p(`Upload progress: ${Math.round(uploadProgress.val)}%`)
        ),
        () => jobId.val && p(`Job ID: ${jobId.val}`)
    )
)};


  const appElement = document.getElementById('app');
   	 if (appElement){ 
      console.log('Mounting app to #app element');
      van.add(appElement, AudioTranscriptionApp());
      console.log('App mounted successfully');
    } else {
      console.error('Cannot find #app element. Please ensure there is a <div id="app"></div> in your HTML.');
    }

console.log('app.js finished loading');
}); // Close the DOMContentLoaded event listener here
