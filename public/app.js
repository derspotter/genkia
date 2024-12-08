const { div, form, input, label, button, p, progress } = van.tags;

const AudioTranscriptionApp = () => {
  const email = van.state('');
  const file = van.state(null);
  const status = van.state('');
  const isVerified = van.state(false);
  const uploadProgress = van.state(0);
  const uploading = van.state(false);

  const checkVerification = async () => {
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
        status.val = response.status === 400 ? data.message : 'Error verifying email';
      } else if (data.verified) {
        isVerified.val = true;
        status.val = 'Email verified. You can now upload your file.';
      } else {
        isVerified.val = false;
        status.val = 'Verification email sent. Please check your inbox and click the verification link.';
      }
    } catch (error) {
      status.val = `Error: ${error.message}`;
    }
  };

  const handleUpload = async () => {
    if (!file.val) {
      status.val = "Please select a file first";
      return;
    }

    if (uploading.val) {
      status.val = "Upload already in progress";
      return;
    }

    const CHUNK_SIZE = 1024 * 1024;
    const totalChunks = Math.ceil(file.val.size / CHUNK_SIZE);
    const fileId = crypto.randomUUID();
    const sanitizedFileName = file.val.name.replace(/[^\x00-\x7F]/g, '_');

    uploading.val = true;
    status.val = "Starting upload...";
    uploadProgress.val = 0;

    try {
      for (let i = 0; i < totalChunks; i++) {
        const chunk = file.val.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        status.val = `Preparing chunk ${i + 1}/${totalChunks}`;

        const response = await fetch('/api/upload-chunk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Number': i.toString(),
            'X-Total-Chunks': totalChunks.toString(),
            'X-File-Id': fileId,
            'X-File-Name': sanitizedFileName,
            'X-Email': email.val
          },
          body: chunk
        });

        if (!response.ok) throw new Error(`Upload failed: ${response.statusText}`);

        const result = await response.json();
        uploadProgress.val = result.progress;
        status.val = `Uploading: ${result.progress}%`;
      }

      status.val = "Upload complete, processing...";
    } catch (error) {
      status.val = `Error: ${error.message}`;
    } finally {
      uploading.val = false;
    }
  };

  return div(
    // Email section
    div(
      label({ for: 'email' }, 'Email: '),
      input({
        type: 'email',
        id: 'email',
        value: email.val,
        oninput: e => email.val = e.target.value
      }),
      button({ onclick: checkVerification }, 'Verify Email')
    ),

    // Status message
    p(status),

    // Upload section - always create it but control visibility with CSS
    div({ style: () => `display: ${isVerified.val ? 'block' : 'none'}` },
      div(
        label({ for: 'file' }, 'Audio File: '),
        input({
          type: 'file',
          id: 'file',
          accept: 'audio/*',
          onchange: e => file.val = e.target.files[0],
          disabled: uploading.val
        })
      ),
      div(
        button({
          onclick: handleUpload,
          disabled: uploading.val || !file.val
        }, uploading.val ? 'Uploading...' : 'Upload and Transcribe')
      ),
      div({ style: () => `display: ${uploadProgress.val > 0 ? 'block' : 'none'}` },
        progress({ value: uploadProgress.val, max: 100 }),
        p(`Upload progress: ${Math.round(uploadProgress.val)}%`)
      )
    )
  );
};

// Mount the app
van.add(document.getElementById('app'), AudioTranscriptionApp());