import { merger } from './pdf.engine.js';

// --- DOM ELEMENTS ---
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const mergeBtn = document.getElementById('mergeBtn');
const statusBar = document.getElementById('statusBar');

// Mode Switch Elements
const btnModeMerge = document.getElementById('btnModeMerge');
const btnModeSplit = document.getElementById('btnModeSplit');
const btnModeForm = document.getElementById('btnModeForm');
const splitControls = document.getElementById('splitControls');
const jobNameInput = document.getElementById('jobNameInput');

// Form Workspace Elements
const formWorkspace = document.getElementById('formWorkspace');
const fieldNameInput = document.getElementById('fieldNameInput');
const btnApplyField = document.getElementById('btnApplyField');
const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const zoomLabel = document.getElementById('zoomLabel');
const canvas = document.getElementById('pdfCanvas');
const selectionBox = document.getElementById('selectionBox');

// --- APP STATE ---
let selectedFiles = [];
let appMode = 'MERGE';
let dragStartIndex;

// Form Editor & Zoom State
let rawFormPdfBuffer = null;
let currentZoom = 1.0; // Multiplier: 1.0 = 100%, 1.5 = 150%, 2.0 = 200%
let baseRenderScale = 1.0;
let totalRenderScale = 1.0;
let isDrawing = false;
let startX = 0;
let startY = 0;
let boxCoords = { left: 0, top: 0, width: 0, height: 0 };

// PDF.js Worker Configuration
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// --- WORKER EVENT LISTENER (Merge / Split) ---
merger.worker.addEventListener('message', (e) => {
    const { status, message } = e.data;
    
    if (status === 'loading' || status === 'working') {
        statusBar.innerText = `> SYSTEM: ${message}`;
        statusBar.style.color = '#58a6ff';
    } else if (status === 'ready') {
        statusBar.innerText = `> SYSTEM: WORKER READY. WAITING FOR INPUT.`;
        statusBar.style.color = '#58a6ff';
        checkReadyState();
    } else if (status === 'complete') {
        statusBar.innerText = `> SYSTEM: OPERATION SUCCESSFUL. INITIATING DOWNLOAD.`;
        statusBar.style.color = '#238636';
        mergeBtn.innerText = "DOWNLOAD STARTED";
        
        setTimeout(() => {
            selectedFiles = [];
            renderFileList();
            statusBar.innerText = `> SYSTEM: READY FOR NEXT JOB.`;
            statusBar.style.color = '#58a6ff';
            checkReadyState();
        }, 3000);
    } else if (status === 'error') {
        statusBar.innerText = `> ERROR: ${e.data.error}`;
        statusBar.style.color = '#f85149';
        mergeBtn.innerText = "ERROR - RETRY?";
        checkReadyState();
    }
});

// --- MODE SWITCHING ---
function setMode(mode) {
    appMode = mode;
    selectedFiles = [];
    rawFormPdfBuffer = null;
    currentZoom = 1.0;
    renderFileList();
    resetCanvas();

    btnModeMerge.classList.toggle('active', mode === 'MERGE');
    btnModeSplit.classList.toggle('active', mode === 'SPLIT');
    btnModeForm.classList.toggle('active', mode === 'FORM');

    if (mode === 'FORM') {
        splitControls.style.display = 'none';
        fileList.style.display = 'none';
        mergeBtn.style.display = 'none';
        formWorkspace.style.display = 'block';
        statusBar.innerText = `> SYSTEM: FIELD EDITOR ACTIVE. DROP A PLACARD PDF TO BEGIN.`;
        statusBar.style.color = '#58a6ff';
    } else if (mode === 'SPLIT') {
        splitControls.style.display = 'block';
        fileList.style.display = 'block';
        mergeBtn.style.display = 'block';
        formWorkspace.style.display = 'none';
        checkReadyState();
    } else {
        splitControls.style.display = 'none';
        fileList.style.display = 'block';
        mergeBtn.style.display = 'block';
        formWorkspace.style.display = 'none';
        checkReadyState();
    }
}

btnModeMerge.onclick = () => setMode('MERGE');
btnModeSplit.onclick = () => setMode('SPLIT');
btnModeForm.onclick = () => setMode('FORM');

// --- FILE INPUT HANDLING ---
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});

async function handleFiles(fileListObj) {
    const newFiles = Array.from(fileListObj).filter(f => f.type === 'application/pdf');
    if (newFiles.length === 0) return;

    if (appMode === 'FORM') {
        const file = newFiles[0];
        rawFormPdfBuffer = await file.arrayBuffer();
        currentZoom = 1.0;
        await renderPdfToCanvas();
        statusBar.innerText = `> SYSTEM: LOADED ${file.name}. DRAG A BOX OVER THE FIELD AREA.`;
        statusBar.style.color = '#58a6ff';
    } else if (appMode === 'SPLIT') {
        selectedFiles = [newFiles[0]];
        renderFileList();
    } else {
        selectedFiles = [...selectedFiles, ...newFiles];
        renderFileList();
    }
}

// --- CANVAS RENDERING (PDF.js) ---
async function renderPdfToCanvas() {
    if (!rawFormPdfBuffer) return;

    // Reset current box on zoom change to avoid scaling mismatch
    selectionBox.style.display = 'none';
    boxCoords = { left: 0, top: 0, width: 0, height: 0 };
    zoomLabel.innerText = `${Math.round(currentZoom * 100)}%`;

    const loadingTask = pdfjsLib.getDocument({ data: rawFormPdfBuffer.slice(0) });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);

    const unscaledViewport = page.getViewport({ scale: 1.0 });
    
    // Fit width to standard 560px baseline
    const baseWidth = Math.min(560, window.innerWidth - 80);
    baseRenderScale = baseWidth / unscaledViewport.width;
    totalRenderScale = baseRenderScale * currentZoom;

    const viewport = page.getViewport({ scale: totalRenderScale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
}

function resetCanvas() {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    selectionBox.style.display = 'none';
    boxCoords = { left: 0, top: 0, width: 0, height: 0 };
}

// --- ZOOM CONTROLS ---
btnZoomIn.addEventListener('click', async () => {
    if (!rawFormPdfBuffer || currentZoom >= 3.0) return;
    currentZoom = +(currentZoom + 0.25).toFixed(2);
    await renderPdfToCanvas();
});

btnZoomOut.addEventListener('click', async () => {
    if (!rawFormPdfBuffer || currentZoom <= 0.5) return;
    currentZoom = +(currentZoom - 0.25).toFixed(2);
    await renderPdfToCanvas();
});

// --- INTERACTIVE BOUNDING BOX (Mouse Drag) ---
canvas.addEventListener('mousedown', (e) => {
    if (!rawFormPdfBuffer) return;
    const rect = canvas.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    isDrawing = true;

    selectionBox.style.left = `${startX}px`;
    selectionBox.style.top = `${startY}px`;
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    selectionBox.style.display = 'block';
});

window.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const currentX = Math.max(0, Math.min(e.clientX - rect.left, canvas.width));
    const currentY = Math.max(0, Math.min(e.clientY - rect.top, canvas.height));

    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    boxCoords = { left, top, width, height };

    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
});

window.addEventListener('mouseup', () => {
    isDrawing = false;
});

// --- ACROFORM INJECTION (pdf-lib) ---
btnApplyField.addEventListener('click', async () => {
    if (!rawFormPdfBuffer) {
        alert("Please load a PDF document first.");
        return;
    }
    if (boxCoords.width < 5 || boxCoords.height < 5) {
        alert("Please click and drag a box on the document to position the field.");
        return;
    }

    const lib = window.PDFLib;
    if (!lib) {
        alert("PDFLib library failed to load from CDN. Please check your network or ad blocker.");
        return;
    }

    try {
        statusBar.innerText = `> SYSTEM: INJECTING ACROFORM FIELD...`;
        statusBar.style.color = '#58a6ff';

        // Translate Screen Pixels -> Unscaled PDF Points
        const pdfX = boxCoords.left / totalRenderScale;
        const pdfWidth = boxCoords.width / totalRenderScale;
        const pdfHeight = boxCoords.height / totalRenderScale;
        const pdfY = (canvas.height - (boxCoords.top + boxCoords.height)) / totalRenderScale;

        const { PDFDocument, rgb } = lib;
        const pdfDoc = await PDFDocument.load(rawFormPdfBuffer.slice(0));
        const page = pdfDoc.getPages()[0];
        const form = pdfDoc.getForm();

        const rawName = fieldNameInput.value.trim() || `Field_${Date.now()}`;
        const cleanName = rawName.replace(/[^a-zA-Z0-9_]/g, '_');

        const textField = form.createTextField(cleanName);
        textField.addToPage(page, {
            x: pdfX,
            y: pdfY,
            width: pdfWidth,
            height: pdfHeight,
            borderWidth: 1,
            borderColor: rgb(0.2, 0.4, 0.8),
        });
        textField.setFontSize(10);

        const modifiedPdfBytes = await pdfDoc.save();
        triggerDownload(modifiedPdfBytes, `${cleanName}_form.pdf`);

        statusBar.innerText = `> SYSTEM: FIELD INJECTED. FILE DOWNLOADED.`;
        statusBar.style.color = '#238636';

        selectionBox.style.display = 'none';
        boxCoords = { left: 0, top: 0, width: 0, height: 0 };
    } catch (err) {
        console.error(err);
        statusBar.innerText = `> ERROR: FAILED TO INJECT FIELD. ${err.message}`;
        statusBar.style.color = '#f85149';
    }
});

function triggerDownload(uint8Array, filename) {
    const blob = new Blob([uint8Array], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// --- MERGE / SPLIT LIST MANAGEMENT ---
function renderFileList() {
    fileList.innerHTML = '';
    selectedFiles.forEach((file, index) => {
        if (!file) return;

        const item = document.createElement('div');
        item.classList.add('file-item');
        item.setAttribute('draggable', 'true');
        item.dataset.index = index;

        item.innerHTML = `
            <div class="drag-handle"></div>
            <div class="file-info">
                <span class="file-name">${index + 1}. ${file.name}</span>
                <span class="file-meta">${(file.size / 1024 / 1024).toFixed(2)} MB</span>
            </div>
            <div class="remove-btn" onclick="window.removeFile(${index})" title="Remove file"></div>
        `;

        item.addEventListener('dragstart', (e) => {
            dragStartIndex = +item.dataset.index;
            setTimeout(() => item.classList.add('dragging'), 0);
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragEndIndex = +item.dataset.index;
            if (dragStartIndex !== dragEndIndex) item.classList.add('drag-over');
        });

        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            const dragEndIndex = +item.dataset.index;
            swapItems(dragStartIndex, dragEndIndex);
            item.classList.remove('drag-over');
            item.classList.remove('dragging');
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            item.classList.remove('drag-over');
        });

        fileList.appendChild(item);
    });

    checkReadyState();
}

window.removeFile = (index) => {
    selectedFiles.splice(index, 1);
    renderFileList();
};

function swapItems(fromIndex, toIndex) {
    const itemToMove = selectedFiles[fromIndex];
    selectedFiles.splice(fromIndex, 1);
    selectedFiles.splice(toIndex, 0, itemToMove);
    renderFileList();
}

function checkReadyState() {
    const isWorkerReady = statusBar.innerText.includes("READY") || 
                          statusBar.innerText.includes("WAITING") || 
                          statusBar.innerText.includes("SUCCESS") || 
                          statusBar.innerText.includes("NEXT JOB");
    let isReady = false;

    if (appMode === 'MERGE') {
        isReady = selectedFiles.length >= 2 && isWorkerReady;
        mergeBtn.innerText = isReady ? "MERGE_PDFS()" : "ADD AT LEAST 2 FILES";
    } else if (appMode === 'SPLIT') {
        isReady = selectedFiles.length === 1 && isWorkerReady;
        mergeBtn.innerText = isReady ? "SPLIT PDF" : "SELECT SINGLE PDF";
    }

    mergeBtn.classList.toggle('ready', isReady);
}

// --- MERGE / SPLIT EXECUTION ---
mergeBtn.addEventListener('click', () => {
    if (!mergeBtn.classList.contains('ready')) return;

    mergeBtn.innerText = "PROCESSING...";
    mergeBtn.classList.remove('ready');

    if (appMode === 'MERGE') {
        merger.mergeFiles(selectedFiles);
    } else if (appMode === 'SPLIT') {
        const jobName = jobNameInput.value.trim() || "split_files";
        merger.splitPDF(selectedFiles[0], jobName);
    }
});
