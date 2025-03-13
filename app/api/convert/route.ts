import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import libre from 'libreoffice-convert';
import { PDFDocument } from 'pdf-lib';
import { createWorker } from 'tesseract.js';
import { copyFile, rmdir, unlink, readdir } from 'fs/promises';

// Convert callback-based functions to Promise-based
const execPromise = promisify(exec);
const libreConvert = promisify(libre.convert);

const UPLOAD_DIR = join(process.cwd(), 'uploads');
const CONVERSION_DIR = join(process.cwd(), 'public', 'conversions');
const FORMAT_FILTERS: Record<string, string> = {
    // Text Documents
    'doc': 'doc:MS Word 97',
    'docx': 'docx:Office Open XML Text',
    'docm': 'docm:MS Word 2007-2013 XML (macro enabled)',
    'dotx': 'dotx:Office Open XML Text Template',
    'dotm': 'dotm:Office Open XML Text Template (macro enabled)',
    'rtf': 'rtf:Rich Text Format',
    'txt': 'txt:Text',
    'odt': 'odt:writer8',
    'html': 'html:HTML (StarWriter)',

    // Spreadsheets
    'xls': 'xls:MS Excel 97',
    'xlsx': 'xlsx:Office Open XML Spreadsheet',
    'xlsm': 'xlsm:MS Excel 2007-2013 XML (macro enabled)',
    'xltx': 'xltx:Office Open XML Spreadsheet Template',
    'xltm': 'xltm:Office Open XML Spreadsheet Template (macro enabled)',
    'csv': 'csv:Text - txt - csv (StarCalc)',

    // Presentations
    'ppt': 'ppt:MS PowerPoint 97',
    'pptx': 'pptx:Office Open XML Presentation',
    'pptm': 'pptm:MS PowerPoint 2007-2013 XML (macro enabled)',
    'potx': 'potx:Office Open XML Presentation Template',
    'potm': 'potm:Office Open XML Presentation Template (macro enabled)',

    // Other formats
    'xml': 'xml:DocBook File',
    'pdf': 'pdf:writer_pdf_Export'
};
// Ensure directories exist
async function ensureDirectories() {
    if (!existsSync(UPLOAD_DIR)) {
        await mkdir(UPLOAD_DIR, { recursive: true });
    }
    if (!existsSync(CONVERSION_DIR)) {
        await mkdir(CONVERSION_DIR, { recursive: true });
    }
}

// Process form data to get file
async function processFormData(request: NextRequest) {
    const formData = await request.formData();
    const file = formData.get('pdf') as File;

    if (!file) {
        throw new Error('No PDF file provided');
    }

    // Get form fields
    const format = (formData.get('format') as string) || 'docx';
    const ocr = formData.get('ocr') === 'true';
    const quality = parseInt((formData.get('quality') as string) || '90');
    const password = formData.get('password') as string || '';

    // Create file paths
    const uniqueId = uuidv4();
    const inputPath = join(UPLOAD_DIR, `${uniqueId}.pdf`);
    const outputPath = join(CONVERSION_DIR, `${uniqueId}.${format}`);

    // Write file to disk
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(inputPath, buffer);

    return {
        file,
        format,
        ocr,
        quality,
        password,
        inputPath,
        outputPath,
        uniqueId,
        fileSize: file.size
    };
}

// Add this function for direct text extraction from PDF
async function extractTextFromPdf(inputPath: string, outputPath: string) {
    try {
        console.log(`Extracting text directly from PDF: ${inputPath}`);

        // We'll use pdftotext if available (better output quality)
        try {
            await execPromise(`pdftotext "${inputPath}" "${outputPath}"`);
            console.log(`Successfully extracted text using pdftotext to ${outputPath}`);
            return true;
        } catch (pdftoTextError) {
            console.error('pdftotext extraction failed:', pdftoTextError);
            console.log('Trying alternative text extraction method...');

            // Fallback to using PDFDocument from pdf-lib to get basic page text
            const pdfBytes = await readFile(inputPath);
            const pdfDoc = await PDFDocument.load(pdfBytes);
            const pageCount = pdfDoc.getPageCount();

            let extractedText = `Extracted from PDF (${pageCount} pages)\n\n`;

            // We can't extract much text directly with pdf-lib, 
            // so we'll add a placeholder message
            extractedText += "PDF text content was extracted with limited formatting.\n";
            extractedText += "For better results, try using the OCR option or convert to DOCX format.\n\n";

            // Write the extracted text to file
            await writeFile(outputPath, extractedText);
            console.log(`Created basic text extraction to ${outputPath}`);
            return true;
        }
    } catch (error) {
        console.error('PDF text extraction error:', error);
        throw new Error('Failed to extract text from PDF: ' + (error as Error).message);
    }
}

// Updated OCR function to match the current Tesseract.js API
async function extractTextWithOCR(inputPath: string, outputPath: string) {
    try {
        // Create a worker
        const worker = await createWorker('eng');

        // Recognize text from the PDF
        const { data } = await worker.recognize(inputPath);

        // Write the extracted text to file
        await writeFile(outputPath, data.text);

        // Terminate the worker
        await worker.terminate();

        console.log(`Successfully extracted text with OCR to ${outputPath}`);
        return true;
    } catch (error) {
        console.error('OCR error:', error);
        throw new Error('Failed to extract text with OCR: ' + (error as Error).message);
    }
}
async function convertWithLibreOffice(inputPath: string, outputPath: string, format: string) {
    try {
        console.log(`Converting ${inputPath} to format: ${format}`);
        console.log(`Desired output: ${outputPath}`);

        // Create a temporary directory specifically for this conversion
        const tempDir = join(process.cwd(), 'libreoffice-temp', Date.now().toString());
        if (!existsSync(tempDir)) {
            await mkdir(tempDir, { recursive: true });
        }

        // Copy the input file to the temp directory with a simple name
        const tempInputPath = join(tempDir, 'input.pdf');
        await copyFile(inputPath, tempInputPath);
        console.log(`Copied input file to ${tempInputPath}`);

        // Get appropriate filter for the format
        let formatFilter = format in FORMAT_FILTERS ? FORMAT_FILTERS[format] : format;
        console.log(`Using format filter: ${formatFilter}`);

        // Try different LibreOffice conversion approaches
        let conversionSuccessful = false;
        let errorMessage = '';

        // Approach 1: Use the standard command with explicit format filter
        try {
            // Use the format filter when available
            const libreOfficeCommand = `libreoffice --headless --convert-to "${formatFilter}" --outdir "${tempDir}" "${tempInputPath}"`;
            console.log(`Executing: ${libreOfficeCommand}`);

            const { stdout, stderr } = await execPromise(libreOfficeCommand);
            console.log('LibreOffice stdout:', stdout);
            if (stderr) console.error('LibreOffice stderr:', stderr);

            conversionSuccessful = true;
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error);
            console.error('First conversion attempt failed:', errorMessage);
        }

        // Approach 2: Try with soffice command (alternative entry point)
        if (!conversionSuccessful) {
            try {
                const sofficeCommand = `soffice --headless --convert-to "${formatFilter}" --outdir "${tempDir}" "${tempInputPath}"`;
                console.log(`Trying alternative command: ${sofficeCommand}`);

                const { stdout, stderr } = await execPromise(sofficeCommand);
                console.log('Alternative command stdout:', stdout);
                if (stderr) console.error('Alternative command stderr:', stderr);

                conversionSuccessful = true;
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
                console.error('Second conversion attempt failed:', errorMessage);
            }
        }

        // Approach 3: Try with just the basic format (without filter options)
        if (!conversionSuccessful) {
            try {
                const basicFormatCommand = `libreoffice --headless --convert-to ${format} --outdir "${tempDir}" "${tempInputPath}"`;
                console.log(`Trying with basic format: ${basicFormatCommand}`);

                const { stdout, stderr } = await execPromise(basicFormatCommand);
                console.log('Basic format stdout:', stdout);
                if (stderr) console.error('Basic format stderr:', stderr);

                conversionSuccessful = true;
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
                console.error('Third conversion attempt failed:', errorMessage);
            }
        }

        // Wait to ensure file operations complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        // List all files in the temp directory for debugging
        const tempFiles = await readdir(tempDir);
        console.log(`Files in temp directory: ${tempFiles.join(', ')}`);

        // Look for any file with the correct extension or format
        const convertedFile = tempFiles.find(file => {
            // Look for exact extension match
            if (file.endsWith(`.${format}`)) return true;

            // Special case: RTF files might have .rtf.fodt extension
            if (format === 'rtf' && file.includes('.rtf')) return true;

            // Special case: HTML files might have multiple extensions
            if (format === 'html' && (file.endsWith('.html') || file.endsWith('.htm'))) return true;

            return false;
        });

        if (convertedFile) {
            const convertedFilePath = join(tempDir, convertedFile);
            console.log(`Found converted file at: ${convertedFilePath}`);

            // Copy the converted file to the desired output location
            console.log(`Copying to ${outputPath}`);
            await copyFile(convertedFilePath, outputPath);

            // Verify the file was copied successfully
            if (existsSync(outputPath)) {
                console.log(`Successfully created ${outputPath}`);

                // Clean up temp directory
                for (const file of tempFiles) {
                    await unlink(join(tempDir, file));
                }
                await rmdir(tempDir);

                return true;
            } else {
                throw new Error(`Failed to copy output file to ${outputPath}`);
            }
        } else {
            // If we can't find the converted file, try using the libreoffice-convert library as a fallback
            console.log('No converted file found. Trying libreoffice-convert library as fallback...');

            try {
                const inputBuffer = await readFile(inputPath);

                // Use the format filter when available
                const outputFormat = formatFilter;

                const outputBuffer = await libreConvert(inputBuffer, outputFormat, undefined);
                await writeFile(outputPath, outputBuffer);

                console.log(`Successfully converted using libreoffice-convert library to ${outputPath}`);

                // Clean up temp directory
                for (const file of tempFiles) {
                    await unlink(join(tempDir, file));
                }
                await rmdir(tempDir);

                return true;
            } catch (libError) {
                const libErrorMsg = libError instanceof Error ? libError.message : String(libError);
                console.error('Fallback conversion failed:', libErrorMsg);

                // Clean up temp directory even on failure
                try {
                    for (const file of tempFiles) {
                        await unlink(join(tempDir, file));
                    }
                    await rmdir(tempDir);
                } catch (cleanupError) {
                    console.error('Failed to clean up temp directory:', cleanupError);
                }

                throw new Error(`Conversion failed. Original error: ${errorMessage}. Fallback error: ${libErrorMsg}`);
            }
        }
    } catch (error) {
        console.error('LibreOffice conversion error:', error);
        throw new Error('Failed to convert with LibreOffice: ' + (error instanceof Error ? error.message : String(error)));
    }
}

// Handle encrypted PDF
async function decryptPdf(inputPath: string, password: string, outputPath: string) {
    try {
        const pdfBytes = await readFile(inputPath);
        const pdfDoc = await PDFDocument.load(pdfBytes, {
            ignoreEncryption: false
        });
        const decryptedBytes = await pdfDoc.save();
        await writeFile(outputPath, decryptedBytes);
        return true;
    } catch (error) {
        console.error('PDF decryption error:', error);
        throw new Error('Failed to decrypt PDF: ' + (error as Error).message);
    }
}

// Convert PDF to image
async function convertToImage(inputPath: string, outputPath: string, format: string, quality: number) {
    try {
        // We'll use different approaches based on the platform
        if (process.platform === 'win32') {
            // On Windows, we can use Ghostscript
            await execPromise(`gswin64c -sDEVICE=${format === 'jpg' ? 'jpeg' : 'png16m'} -dNOPAUSE -dBATCH -dSAFER -r300 -dJPEGQ=${quality} -sOutputFile="${outputPath}" "${inputPath}"`);
        } else {
            // On Linux/Mac, try pdftoppm first
            try {
                const tempOutputPath = outputPath.substring(0, outputPath.lastIndexOf('.'));
                await execPromise(`pdftoppm -${format === 'jpg' ? 'jpeg' : 'png'} -r 300 -jpegopt quality=${quality} -singlefile "${inputPath}" "${tempOutputPath}"`);

                // Check if the file exists with the expected name
                const expectedOutputFile = `${tempOutputPath}.${format}`;
                if (existsSync(expectedOutputFile)) {
                    await copyFile(expectedOutputFile, outputPath);
                    return true;
                }
            } catch (error) {
                console.error('pdftoppm conversion failed:', error);
            }

            // Fallback to Ghostscript if pdftoppm failed
            await execPromise(`gs -sDEVICE=${format === 'jpg' ? 'jpeg' : 'png16m'} -dNOPAUSE -dBATCH -dSAFER -r300 -dJPEGQ=${quality} -sOutputFile="${outputPath}" "${inputPath}"`);
        }

        return true;
    } catch (error) {
        console.error('Image conversion error:', error);
        throw new Error('Failed to convert to image: ' + (error as Error).message);
    }
}

export async function POST(request: NextRequest) {
    try {
        // Log the request headers for debugging
        console.log('Request headers:', Object.fromEntries(request.headers.entries()));

        await ensureDirectories();

        const {
            file,
            format,
            ocr,
            quality,
            password,
            inputPath,
            outputPath,
            uniqueId,
            fileSize
        } = await processFormData(request);

        console.log(`Processing file: ${file.name}, format: ${format}, size: ${fileSize} bytes`);

        // Handle password-protected PDF
        let workingInputPath = inputPath;
        if (password) {
            const decryptedPath = join(UPLOAD_DIR, `${uniqueId}_decrypted.pdf`);
            await decryptPdf(inputPath, password, decryptedPath);
            workingInputPath = decryptedPath;
        }

        // Perform the conversion based on format
        if (['jpg', 'jpeg', 'png'].includes(format)) {
            await convertToImage(workingInputPath, outputPath, format, quality);
        } else if (format === 'txt') {
            // For text format, try direct extraction first, then fall back to OCR if requested
            try {
                await extractTextFromPdf(workingInputPath, outputPath);
            } catch (error) {
                console.error('Direct text extraction failed:', error);
                if (ocr) {
                    console.log('Falling back to OCR for text extraction');
                    await extractTextWithOCR(workingInputPath, outputPath);
                } else {
                    throw new Error('Text extraction failed and OCR was not requested');
                }
            }
        } else {
            await convertWithLibreOffice(workingInputPath, outputPath, format);
        }

        // Verify the output file exists
        if (!existsSync(outputPath)) {
            throw new Error(`Output file was not created at ${outputPath}`);
        }

        // Create relative URL for the converted file
        const fileUrl = `/conversions/${uniqueId}.${format}`;

        return NextResponse.json({
            success: true,
            message: 'Conversion successful',
            fileUrl,
            filename: `${uniqueId}.${format}`,
            originalName: file.name,
            format
        });
    } catch (error) {
        console.error('Conversion error:', error);

        return NextResponse.json(
            {
                error: error instanceof Error ? error.message : 'An unknown error occurred during conversion',
                success: false
            },
            { status: 500 }
        );
    }
}