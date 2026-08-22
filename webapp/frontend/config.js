// Update these URLs after deploying the backend services
window.CONFIG_DDS_API = 'https://bridge-dds-api.onrender.com';
window.CONFIG_WORKER_API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? ''
  : 'https://bridge-dds-worker.jessie-lee-tx.workers.dev';
