import sharp from 'sharp';
import redirect from './redirect.js';
import { URL } from 'url';

// Sharpening parameters
const sharpenParams = {
  sigma: 1.0,
  flat: 1.0,
  jagged: 0.5
};

// Max dimensions for AVIF to avoid HEIF format size limits
const MAX_HEIF_DIMENSION = 16384;

// Optimized compress function for limited resources
async function compress(req, res, input) {
  try {
    const format = req.params.webp ? 'avif' : 'jpeg';
    const { grayscale, originSize, url } = req.params;

    const metadata = await sharp(input).metadata();
    const { width, height, pages } = metadata;
    const pixelCount = width * height;

    const isAnimated = pages && pages > 1;
    let outputFormat = isAnimated ? 'webp' : format;

    const compressionQuality = req.params.quality;

    const { tileRows, tileCols, minQuantizer, maxQuantizer, effort } = optimizeAvifParams(width, height);

    let sharpInstance = sharp(input, { animated: isAnimated });

    if (grayscale) {
      sharpInstance = sharpInstance.grayscale();
    }

    if (!isAnimated) {
      if (outputFormat === 'jpeg' || outputFormat === 'avif') {
        sharpInstance = applyArtifactReduction(sharpInstance, pixelCount);
      }
      if (pixelCount > 500000) {
        sharpInstance = sharpInstance.sharpen(sharpenParams.sigma, sharpenParams.flat, sharpenParams.jagged);
      }
    }

    // Resize image to fit within AVIF max dimensions if necessary
    if (outputFormat === 'avif' && (width > MAX_HEIF_DIMENSION || height > MAX_HEIF_DIMENSION)) {
      sharpInstance = sharpInstance.resize({
        width: Math.min(width, MAX_HEIF_DIMENSION),
        height: Math.min(height, MAX_HEIF_DIMENSION),
        fit: 'inside',
      });
    }

    // Set output format and options
    sharpInstance = sharpInstance.toFormat(outputFormat, {
      quality: compressionQuality,
      alphaQuality: 80,
      smartSubsample: true,
      chromaSubsampling: '4:2:0',
      tileRows: outputFormat === 'avif' ? tileRows : undefined,
      tileCols: outputFormat === 'avif' ? tileCols : undefined,
      minQuantizer: outputFormat === 'avif' ? minQuantizer : undefined,
      maxQuantizer: outputFormat === 'avif' ? maxQuantizer : undefined,
      effort: outputFormat === 'avif' ? effort : undefined,
      loop: isAnimated ? 0 : undefined,
    });

    try {
      const outputStream = sharpInstance.toBuffer({ resolveWithObject: true });
      const { data: output, info } = await outputStream;

      if (res.headersSent) {
        console.error('Headers already sent, unable to compress the image.');
        return;
      }

      sendImage(res, output, outputFormat, url, originSize, info.size);
    } catch (heifError) {
      if (heifError.message.includes("too large for the HEIF format")) {
        console.warn("Image too large for HEIF format, falling back to JPEG/WebP.");
        outputFormat = isAnimated ? 'webp' : 'jpeg'; // Fallback format
        sharpInstance = sharpInstance.toFormat(outputFormat, { quality: compressionQuality });
        
        const { data: output, info } = await sharpInstance.toBuffer({ resolveWithObject: true });
        sendImage(res, output, outputFormat, url, originSize, info.size);
      } else {
        throw heifError;
      }
    }
  } catch (err) {
    console.error('Error during image compression:', err);
    return redirect(req, res);
  }
}

// Dynamically adjust AVIF parameters for limited resources
function optimizeAvifParams(width, height) {
  const largeImageThreshold = 2000;
  const mediumImageThreshold = 1000;

  if (width > largeImageThreshold || height > largeImageThreshold) {
    return { tileRows: 4, tileCols: 4, minQuantizer: 30, maxQuantizer: 50, effort: 3 };
  } else if (width > mediumImageThreshold || height > mediumImageThreshold) {
    return { tileRows: 2, tileCols: 2, minQuantizer: 28, maxQuantizer: 48, effort: 4 };
  } else {
    return { tileRows: 1, tileCols: 1, minQuantizer: 26, maxQuantizer: 48, effort: 4 };
  }
}

// Apply artifact reduction before sharpening and compression
function applyArtifactReduction(sharpInstance, pixelCount) {
  const thresholds = { large: 3000000, medium: 1000000, small: 500000 };
  const settings = {
    large: { blurRadius: 0.4, denoiseStrength: 0.15, sharpenSigma: 0.8, saturationReduction: 0.85 },
    medium: { blurRadius: 0.35, denoiseStrength: 0.12, sharpenSigma: 0.6, saturationReduction: 0.9 },
    small: { blurRadius: 0.3, denoiseStrength: 0.1, sharpenSigma: 0.5, saturationReduction: 0.95 },
  };
  
  const { blurRadius, denoiseStrength, sharpenSigma, saturationReduction } =
    pixelCount > thresholds.large
      ? settings.large
      : pixelCount > thresholds.medium
      ? settings.medium
      : pixelCount > thresholds.small
      ? settings.small
      : { blurRadius: 0.3, denoiseStrength: 0.1, sharpenSigma: 0.5, saturationReduction: 1.0 };

  return sharpInstance
    .modulate({ saturation: saturationReduction })
    .blur(blurRadius)
    .sharpen(sharpenSigma)
    .gamma();
}

// Send the compressed image as response
function sendImage(res, data, imgFormat, url, originSize, compressedSize) {
  const filename = encodeURIComponent(new URL(url).pathname.split('/').pop() || 'image') + `.${imgFormat}`;

  res.setHeader('Content-Type', `image/${imgFormat}`);
  res.setHeader('Content-Length', data.length);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('x-original-size', originSize || 0);
  res.setHeader('x-bytes-saved', Math.max((originSize || 0) - compressedSize, 0));

  res.status(200).end(data);
}

export default compress;
