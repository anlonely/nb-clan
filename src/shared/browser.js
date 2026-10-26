function fileNameFromContentDisposition(header, fallbackName) {
  const value = String(header || '');
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  const quoted = value.match(/filename="([^"]+)"/i)?.[1];
  if (quoted) return quoted;
  const plain = value.match(/filename=([^;]+)/i)?.[1];
  return plain ? plain.trim() : fallbackName;
}

export async function downloadFetchResponse(response, fallbackName, onProgress = () => {}) {
  const fileName = fileNameFromContentDisposition(response.headers.get('content-disposition'), fallbackName);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const contentLength = Number(response.headers.get('content-length') || 0);
  let blob;
  if (response.body && contentLength > 0) {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(Math.min(99, Math.max(1, Math.round((received / contentLength) * 100))));
    }
    blob = new Blob(chunks, { type: contentType });
  } else {
    blob = await response.blob();
  }
  onProgress(100);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function copyText(text, setToast, t) {
  const value = String(text || '');
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch {
      copied = false;
    }
  }
  if (!copied) {
    const activeElement = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
    } catch {
      // The browser may still block clipboard writes; keep the UI feedback predictable.
    } finally {
      document.body.removeChild(textarea);
      activeElement?.focus?.();
    }
  }
  setToast(t('copied'));
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
