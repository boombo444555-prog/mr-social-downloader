const form = document.querySelector('#form');
const input = document.querySelector('#url');
const button = document.querySelector('#submit');
const status = document.querySelector('#status');

document.querySelector('#year').textContent = new Date().getFullYear();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;

  button.disabled = true;
  button.textContent = 'Preparing…';
  status.className = 'status';
  status.textContent = 'Connecting to the source…';

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      let message = 'Download failed. Please try another link.';
      try {
        const data = await response.json();
        if (data.error) message = data.error;
      } catch {}
      throw new Error(message);
    }

    status.textContent = 'Downloading your video…';
    const blob = await response.blob();
    if (!blob.size) throw new Error('The server returned an empty file. Please try again.');

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'mr-downloader-video.mp4';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);

    status.className = 'status success';
    status.textContent = 'Your download is ready.';
  } catch (error) {
    status.className = 'status error';
    status.textContent = error.message || 'Something went wrong. Please try again.';
  } finally {
    button.disabled = false;
    button.textContent = 'Download video ↗';
  }
});
