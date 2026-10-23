/**
 * Compress image to base64 data URL.
 * Accepts a File object (drag & drop / file input) or a data URL string (from IPC).
 */
export async function compressImageToBase64(
  source: File | string,
  options?: {
    maxSizeMB?: number;
    maxWidthOrHeight?: number;
    quality?: number;
    outputFormat?: 'image/jpeg' | 'image/webp';
  }
): Promise<string> {
  const {
    maxSizeMB = 0.8,
    maxWidthOrHeight = 1920,
    quality = 0.8,
    outputFormat = 'image/jpeg',
  } = options || {};

  const maxBytes = maxSizeMB * 1024 * 1024;

  // Load image from source
  let imgSrc: string;
  let sourceSize: number;
  let needsCleanup = false;

  if (typeof source === 'string') {
    imgSrc = source;
    // Estimate original size from base64
    const base64Part = source.split(',')[1] || '';
    sourceSize = Math.ceil(base64Part.length * 0.75);
  } else {
    imgSrc = URL.createObjectURL(source);
    sourceSize = source.size;
    needsCleanup = true;
  }

  const img = await loadImageFromSrc(imgSrc);

  if (needsCleanup) {
    URL.revokeObjectURL(imgSrc);
  }

  let { width, height } = img;

  const needsResize = width > maxWidthOrHeight || height > maxWidthOrHeight;

  // If no resize needed and small enough, return the original data
  if (!needsResize && sourceSize <= maxBytes) {
    if (typeof source === 'string') {
      return source;
    }
    return fileToBase64(source);
  }

  // Resize if needed
  if (width > maxWidthOrHeight || height > maxWidthOrHeight) {
    const scale = Math.min(maxWidthOrHeight / width, maxWidthOrHeight / height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  // Draw to canvas and compress
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  let currentQuality = quality;
  while (currentQuality > 0.3) {
    const blob = await canvasToBlob(canvas, outputFormat, currentQuality);
    if (blob.size <= maxBytes) {
      return blobToBase64(blob);
    }
    currentQuality -= 0.05;
  }

  const blob = await canvasToBlob(canvas, outputFormat, 0.3);
  return blobToBase64(blob);
}

function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')),
      type, quality
    );
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return fileToBase64(new File([blob], 'image', { type: blob.type }));
}
