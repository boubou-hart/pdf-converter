require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const winston = require('winston');
const { fromPath: pdf2picFromPath } = require('pdf2pic');
const sharp = require('sharp');
const OpenAI = require('openai');
const pLimit = require('p-limit');

// -------------------- CONFIGURATION -------------------- //
const PORT = process.env.PORT || 3000;
// Use temp directory in production, local uploads in development
const UPLOAD_DIR = process.env.NODE_ENV === 'production' 
  ? path.join('/tmp', 'uploads') 
  : path.join(__dirname, 'uploads');

// Ensure upload directory exists
fs.ensureDirSync(UPLOAD_DIR);

// Winston logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'server.log' })
  ]
});

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// -------------------- EXPRESS SETUP -------------------- //
const app = express();

app.get('/', (_req, res) => {
  res.send('PDF Converter Server is running');
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'pdf-converter-server'
  });
});

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    logger.warn('No file uploaded');
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const uploadedPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();

  logger.info(`Received file: ${originalName} (${req.file.size} bytes)`);

  try {
    if (ext === '.pdf') {
      logger.info('File is already a PDF, returning directly');
      return sendFileAndCleanup(res, uploadedPath, originalName, [uploadedPath]);
    }

    // Convert to PDF using LibreOffice
    const pdfPath = await convertToPDF(uploadedPath);
    const pdfName = `${path.parse(originalName).name}.pdf`;
    logger.info(`Conversion successful: ${originalName} -> ${pdfName}`);
    return sendFileAndCleanup(res, pdfPath, pdfName, [uploadedPath, pdfPath]);
  } catch (err) {
    logger.error(`Processing failed: ${err.message}`);
    await safeCleanup([uploadedPath]);
    return res.status(500).json({ error: 'File processing failed', details: err.message });
  }
});

// Job store for downloadable PDFs
const jobs = new Map(); // jobId -> { pdfPath, originalName, expires }
const JOB_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Endpoint: upload + extract -> returns markdown & download URL
app.post('/process', upload.single('file'), async (req, res) => {
  if (!req.file) {
    logger.warn('No file uploaded');
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const cleanupTargets = [];
  const uploadedPath = req.file.path;
  cleanupTargets.push(uploadedPath);
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();

  try {
    // Ensure we have a PDF
    let pdfPath = uploadedPath;
    if (ext !== '.pdf') {
      pdfPath = await convertToPDF(uploadedPath);
      cleanupTargets.push(pdfPath);
    }

    // Convert each page to image and extract text
    const { images, pagesText } = await convertPdfAndExtractText(pdfPath, MAX_PAGES);
    cleanupTargets.push(...images); // images will be deleted immediately

    // Build markdown
    let markdown = '';
    for (const { page, text } of pagesText) {
      markdown += `### Page ${page}\n\n${text}\n\n`;
    }

    // delete images now
    await safeCleanup(images);

    // sanitize markdown
    const sanitizedMarkdown = markdown.replace(/[\u0000-\u001F]/g, ''); // remove all control chars
    const markdownBase64 = Buffer.from(sanitizedMarkdown, 'utf8').toString('base64');

    // register job for PDF download
    const jobId = uuidv4();
    const expires = Date.now() + JOB_TTL_MS;
    jobs.set(jobId, { pdfPath, originalName: path.basename(pdfPath), expires });

    // Return JSON response
    res.json({
      jobId,
      originalName: path.basename(pdfPath),
      markdown: sanitizedMarkdown,
      markdownBase64,
      downloadUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`
    });

    // note: we do not delete pdfPath yet; it will be deleted after download or TTL
  } catch (err) {
    logger.error(`Processing failed: ${err.message}`);
    await safeCleanup(cleanupTargets);
    return res.status(500).json({ error: 'Processing failed', details: err.message });
  }
});

// Endpoint: download PDF by jobId
app.get('/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Invalid or expired jobId' });
  }

  // stream download
  res.download(job.pdfPath, job.originalName, async (err) => {
    if (err) {
      logger.error(`Download error for job ${jobId}: ${err.message}`);
    }
    await safeCleanup([job.pdfPath]);
    jobs.delete(jobId);
  });
});

// Cleanup stale jobs every minute
setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expires < now) {
      await safeCleanup([job.pdfPath]);
      jobs.delete(id);
    }
  }
}, 60 * 1000);

// -------------------- UTILITY FUNCTIONS -------------------- //
function convertToPDF(inputPath) {
  return new Promise((resolve, reject) => {
    const outputDir = path.dirname(inputPath);
    const command = `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${inputPath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        logger.error(`LibreOffice error: ${stderr || error.message}`);
        return reject(new Error('Conversion failed'));
      }

      logger.debug(`LibreOffice stdout: ${stdout}`);
      const pdfPath = path.join(outputDir, `${path.parse(inputPath).name}.pdf`);
      if (!fs.existsSync(pdfPath)) {
        return reject(new Error('PDF not generated'));
      }
      resolve(pdfPath);
    });
  });
}

function sendFileAndCleanup(res, filePath, downloadName, cleanupFiles) {
  res.download(filePath, downloadName, async (err) => {
    if (err) {
      logger.error(`Download error: ${err.message}`);
    }
    await safeCleanup(cleanupFiles);
  });
}

async function safeCleanup(files) {
  for (const file of files) {
    try {
      if (await fs.pathExists(file)) {
        await fs.remove(file);
        logger.info(`Deleted file: ${file}`);
      }
    } catch (cleanupErr) {
      logger.warn(`Failed to delete ${file}: ${cleanupErr.message}`);
    }
  }
}

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY env variable is required');
    }
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

const MAX_PAGES = parseInt(process.env.MAX_PAGES || '20', 10); // safety limit
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10); // parallel OpenAI calls

async function convertPdfAndExtractText(pdfPath, maxPages) {
  const tempImgDir = path.join(path.dirname(pdfPath), uuidv4());
  await fs.ensureDir(tempImgDir);

  const options = {
    density: parseInt(process.env.CONVERT_DPI || '200', 10),
    savePath: tempImgDir,
    format: 'png',
    width: 1654 // ~A4 200dpi
  };
  const convert = pdf2picFromPath(pdfPath, options);

  const images = [];
  const pagesText = [];
  const limit = pLimit(CONCURRENCY);
  const extractionTasks = [];

  for (let page = 1; page <= maxPages; page++) {
    try {
      const result = await convert(page, false); // false = no logging
      const imgPath = result.path;

      // Compress image to speed up upload to OpenAI
      const compressedPath = path.join(tempImgDir, `${path.parse(imgPath).name}-cmp.png`);
      await sharp(imgPath).png({ quality: 80 }).toFile(compressedPath);
      await fs.remove(imgPath);

      images.push(compressedPath);

      // Queue text extraction concurrently (up to CONCURRENCY)
      extractionTasks.push(
        limit(async () => {
          const text = await extractTextFromImage(compressedPath);
          return { page, text };
        })
      );
    } catch (err) {
      if (page === 1) throw err; // if first page fails, propagate
      break; // reached end of document
    }
  }

  // Wait for all extraction tasks to finish
  const extracted = await Promise.all(extractionTasks);
  // Sort to keep page order
  extracted.sort((a, b) => a.page - b.page);
  pagesText.push(...extracted);

  return { images, pagesText };
}

async function extractTextFromImage(imagePath) {
  const imageData = await fs.readFile(imagePath);
  const base64 = imageData.toString('base64');
  const response = await getOpenAI().chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-nano',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract the visible text from this document page image. Return ONLY that text, no explanations.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
        ]
      }
    ]
  });
  return response.choices[0].message.content.trim();
}

// -------------------- START SERVER -------------------- //
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
}); 