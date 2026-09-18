import { merger } from './pdf.engine.js';

// --- DOM ELEMENTS ---
const mainContainer = document.querySelector('.container');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const mergeBtn = document.getElementById('mergeBtn');
const statusBar = document.getElementById('statusBar');

// Mode Switch
const btnModeMerge = document.getElementById('btnModeMerge');
const btnModeSplit = document.getElementById('btnModeSplit');
const btnModeForm = document.getElementById('btnModeForm');
const splitControls = document.getElementById('splitControls');
const jobNameInput = document.getElementById('jobNameInput');

// Full-Page Editor
const formWorkspace = document.getElementById('formWorkspace');
const btnExitEditor = document.getElementById('btnExitEditor');
const editorDropZone = document.getElementById('editorDropZone');
const editorFileInput = document.getElementById('editorFileInput');
const canvasViewport = document.getElementById('canvasViewport');
const canvasWrapper = document.getElementById('canvasWrapper');
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

// Cached PDF Objects (Prevents re-parsing on zoom)
let rawFormPdfBuffer = null;
let loadedPdfDoc = null;
let loadedPdfPage = null;

let currentZoom = 2.0;
let totalRenderScale = 0;
let currentRenderTask = null;

// Interaction State Machine
const InteractionMode = {
    IDLE: 'IDLE',
    DRAWING: 'DRAWING',
    MOVING: 'MOVING',
    RESIZING: 'RESIZING',
    PANNING: 'PANNING'
};
let currentMode = InteractionMode.IDLE;
let isSpacePressed = false;

// Geometry Buffers
let boxCoords = { left: 0, top: 0, width: 0, height: 0 };
let origBox = { left: 0, top: 0, width: 0, height: 0 };
let dragStart = { x: 0, y: 0 };
let activeHandle = null;
let panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };

// PDF.js Worker Configuration
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// Local Loader for pdf-lib
async function getPDFLib() {
    if (window.PDFLib) return window.PDFLib;

    // Fallback: Dynamically load local file if head tag didn't resolve in time
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = './pdf-lib.min.js';
        s.onload = () => {
            if (window.PDFLib) resolve(window.PDFLib);
            else reject(new Error("Local pdf-lib.min.js loaded but PDFLib global not found."));
        };
        s.onerror = () => reject(new Error("Failed to load ./pdf-lib.min.js. Ensure the file is present in your repo root."));
        document.head.appendChild(s);
    });
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
    cleanupPdfDoc();
    currentZoom = 2.0;
    renderFileList();
    resetCanvas();

    if (btnModeMerge) btnModeMerge.classList.toggle('active', mode === 'MERGE');
    if (btnModeSplit) btnModeSplit.classList.toggle('active', mode === 'SPLIT');
    if (btnModeForm) btnModeForm.classList.toggle('active', mode === 'FORM');

    if (mode === 'FORM') {
        if (mainContainer) mainContainer.style.display = 'none';
        formWorkspace.style.display = 'flex';
        editorDropZone.style.display = 'block';
        canvasWrapper.style.display = 'none';
        zoomLabel.innerText = '200%';
    } else {
        if (mainContainer) mainContainer.style.display = 'block';
        formWorkspace.style.display = 'none';
        splitControls.style.display = (mode === 'SPLIT') ? 'block' : 'none';
        fileList.style.display = 'block';
        mergeBtn.style.display = 'block';
        checkReadyState();
    }
}

if (btnModeMerge) btnModeMerge.onclick = () => setMode('MERGE');
if (btnModeSplit) btnModeSplit.onclick = () => setMode('SPLIT');
if (btnModeForm) btnModeForm.onclick = () => setMode('FORM');
if (btnExitEditor) btnExitEditor.onclick = () => setMode('MERGE');

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

editorDropZone.addEventListener('dragover', (e) => { e.preventDefault(); });
editorDropZone.addEventListener('click', () => editorFileInput.click());
editorFileInput.addEventListener('change', (e) => handleFormFile(e.target.files[0]));

editorDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
        handleFormFile(e.dataTransfer.files[0]);
    }
});

async function handleFiles(fileListObj) {
    const newFiles = Array.from(fileListObj).filter(f => f.type === 'application/pdf');
    if (newFiles.length === 0) return;

    if (appMode === 'SPLIT') {
        selectedFiles = [newFiles[0]];
    } else {
        selectedFiles = [...selectedFiles, ...newFiles];
    }
    renderFileList();
}

async function handleFormFile(file) {
    if (!file || file.type !== 'application/pdf') return;

    cleanupPdfDoc();
    rawFormPdfBuffer = await file.arrayBuffer();
    currentZoom = 2.0;

    editorDropZone.style.display = 'none';
    canvasWrapper.style.display = 'block';

    // Parse document once and cache the reference
    const loadingTask = pdfjsLib.getDocument({ data: rawFormPdfBuffer.slice(0) });
    loadedPdfDoc = await loadingTask.promise;
    loadedPdfPage = await loadedPdfDoc.getPage(1);

    totalRenderScale = (96 / 72) * currentZoom;
    await renderCachedPage();
}

function cleanupPdfDoc() {
    if (loadedPdfDoc) {
        loadedPdfDoc.destroy();
        loadedPdfDoc = null;
        loadedPdfPage = null;
    }
}

// --- FAST CANVAS RENDERING (Zero Re-Parsing) ---
async function renderCachedPage() {
    if (!loadedPdfPage) return;

    // Properly await previous render task cancellation to prevent context collisions
    if (currentRenderTask) {
        currentRenderTask.cancel();
        try {
            await currentRenderTask.promise;
        } catch (e) {
            // Expected RenderingCancelledException
        }
        currentRenderTask = null;
    }

    btnZoomIn.disabled = true;
    btnZoomOut.disabled = true;
    zoomLabel.innerText = `${Math.round(currentZoom * 100)}%`;

    const oldScale = totalRenderScale;
    const newScale = (96 / 72) * currentZoom;

    // Scale existing selection box proportionately
    if (boxCoords.width > 0 && oldScale > 0) {
        const scaleFactor = newScale / oldScale;
        boxCoords.left *= scaleFactor;
        boxCoords.top *= scaleFactor;
        boxCoords.width *= scaleFactor;
        boxCoords.height *= scaleFactor;
        updateSelectionBoxDOM();
    }

    totalRenderScale = newScale;

    try {
        const viewport = loadedPdfPage.getViewport({ scale: totalRenderScale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        currentRenderTask = loadedPdfPage.render({ canvasContext: ctx, viewport: viewport });
        await currentRenderTask.promise;
    } catch (err) {
        if (err.name !== 'RenderingCancelledException') {
            console.error('Render error:', err);
        }
    } finally {
        currentRenderTask = null;
        btnZoomIn.disabled = currentZoom >= 3.0;
        btnZoomOut.disabled = currentZoom <= 0.5;
    }
}

function resetCanvas() {
    if (currentRenderTask) {
        currentRenderTask.cancel();
        currentRenderTask = null;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    selectionBox.style.display = 'none';
    boxCoords = { left: 0, top: 0, width: 0, height: 0 };
    totalRenderScale = 0;
}

// --- ZOOM BUTTON CONTROLS ---
btnZoomIn.addEventListener('click', async () => {
    if (!loadedPdfPage || currentZoom >= 3.0) return;
    currentZoom = +(currentZoom + 0.25).toFixed(2);
    await renderCachedPage();
});

btnZoomOut.addEventListener('click', async () => {
    if (!loadedPdfPage || currentZoom <= 0.5) return;
    currentZoom = +(currentZoom - 0.25).toFixed(2);
    await renderCachedPage();
});

// --- PANNING LOGIC ---
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && document.activeElement !== fieldNameInput) {
        isSpacePressed = true;
        canvasViewport.classList.add('panning-ready');
        e.preventDefault();
    }
});

window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
        isSpacePressed = false;
        if (currentMode !== InteractionMode.PANNING) {
            canvasViewport.classList.remove('panning-ready', 'is-panning');
        }
    }
});

// --- CANVAS & TRANSFORM EVENTS ---
canvasViewport.addEventListener('mousedown', (e) => {
    if (!loadedPdfPage) return;

    if (isSpacePressed || e.button === 1) {
        currentMode = InteractionMode.PANNING;
        panStart = {
            x: e.clientX,
            y: e.clientY,
            scrollLeft: canvasViewport.scrollLeft,
            scrollTop: canvasViewport.scrollTop
        };
        canvasViewport.classList.add('is-panning');
        e.preventDefault();
        return;
    }

    if (e.button !== 0) return;

    const handleEl = e.target.closest('.handle');
    const isBoxClick = e.target === selectionBox;
    const canvasRect = canvas.getBoundingClientRect();

    dragStart = { x: e.clientX, y: e.clientY };
    origBox = { ...boxCoords };

    if (handleEl) {
        currentMode = InteractionMode.RESIZING;
        activeHandle = handleEl.dataset.handle;
        e.stopPropagation();
    } else if (isBoxClick) {
        currentMode = InteractionMode.MOVING;
        e.stopPropagation();
    } else if (e.target === canvas) {
        currentMode = InteractionMode.DRAWING;
        const startX = Math.max(0, Math.min(e.clientX - canvasRect.left, canvas.width));
        const startY = Math.max(0, Math.min(e.clientY - canvasRect.top, canvas.height));

        boxCoords = { left: startX, top: startY, width: 0, height: 0 };
        updateSelectionBoxDOM();
    }
});

window.addEventListener('mousemove', (e) => {
    if (currentMode === InteractionMode.IDLE) return;

    if (currentMode === InteractionMode.PANNING) {
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        canvasViewport.scrollLeft = panStart.scrollLeft - dx;
        canvasViewport.scrollTop = panStart.scrollTop - dy;
        return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    const minSize = 12;

    if (currentMode === InteractionMode.MOVING) {
        const maxLeft = canvas.width - origBox.width;
        const maxTop = canvas.height - origBox.height;
        boxCoords.left = Math.max(0, Math.min(origBox.left + dx, maxLeft));
        boxCoords.top = Math.max(0, Math.min(origBox.top + dy, maxTop));
        updateSelectionBoxDOM();
    } else if (currentMode === InteractionMode.RESIZING) {
        let { left, top, width, height } = origBox;

        if (activeHandle.includes('e')) width = Math.max(minSize, Math.min(origBox.width + dx, canvas.width - left));
        if (activeHandle.includes('s')) height = Math.max(minSize, Math.min(origBox.height + dy, canvas.height - top));
        if (activeHandle.includes('w')) {
            const proposedLeft = Math.max(0, Math.min(origBox.left + dx, origBox.left + origBox.width - minSize));
            width = origBox.width - (proposedLeft - origBox.left);
            left = proposedLeft;
        }
        if (activeHandle.includes('n')) {
            const proposedTop = Math.max(0, Math.min(origBox.top + dy, origBox.top + origBox.height - minSize));
            height = origBox.height - (proposedTop - origBox.top);
            top = proposedTop;
        }

        boxCoords = { left, top, width, height };
        updateSelectionBoxDOM();
    } else if (currentMode === InteractionMode.DRAWING) {
        const currentX = Math.max(0, Math.min(e.clientX - canvasRect.left, canvas.width));
        const currentY = Math.max(0, Math.min(e.clientY - canvasRect.top, canvas.height));

        const left = Math.min(boxCoords.left, currentX);
        const top = Math.min(boxCoords.top, currentY);
        const width = Math.abs(currentX - (dragStart.x - canvasRect.left));
        const height = Math.abs(currentY - (dragStart.y - canvasRect.top));

        boxCoords = { left, top, width, height };
        updateSelectionBoxDOM();
    }
});

window.addEventListener('mouseup', () => {
    if (currentMode === InteractionMode.PANNING) {
        currentMode = InteractionMode.IDLE;
        if (!isSpacePressed) {
            canvasViewport.classList.remove('panning-ready', 'is-panning');
        } else {
            canvasViewport.classList.remove('is-panning');
        }
        return;
    }

    if (currentMode === InteractionMode.DRAWING) {
        if (boxCoords.width < 10 || boxCoords.height < 10) {
            selectionBox.style.display = 'none';
            boxCoords = { left: 0, top: 0, width: 0, height: 0 };
        }
    }

    currentMode = InteractionMode.IDLE;
    activeHandle = null;
});

function updateSelectionBoxDOM() {
    selectionBox.style.left = `${boxCoords.left}px`;
    selectionBox.style.top = `${boxCoords.top}px`;
    selectionBox.style.width = `${boxCoords.width}px`;
    selectionBox.style.height = `${boxCoords.height}px`;
    selectionBox.style.display = 'block';
}

// --- ACROFORM INJECTION ---
btnApplyField.addEventListener('click', async () => {
    if (!rawFormPdfBuffer) {
        alert("Please load a PDF document first.");
        return;
    }
    if (boxCoords.width < 5 || boxCoords.height < 5) {
        alert("Please draw and position a field box on the document.");
        return;
    }

    try {
        const lib = await getPDFLib();
        const { PDFDocument, rgb, degrees } = lib;
        const pdfDoc = await PDFDocument.load(rawFormPdfBuffer.slice(0));
        const page = pdfDoc.getPages()[0];
        const form = pdfDoc.getForm();

        // 1. Preserve Original Visual Page Orientation
        const pageRotation = loadedPdfPage.rotate || 0;
        page.setRotation(degrees(pageRotation));

        // 2. Transform Screen Pixels -> Exact PDF Point Geometry via PDF.js Matrix
        const viewport = loadedPdfPage.getViewport({ scale: totalRenderScale });
        const [x1, y1] = viewport.convertToPdfPoint(boxCoords.left, boxCoords.top);
        const [x2, y2] = viewport.convertToPdfPoint(
            boxCoords.left + boxCoords.width, 
            boxCoords.top + boxCoords.height
        );

        const pdfX = Math.min(x1, x2);
        const pdfY = Math.min(y1, y2);
        const pdfWidth = Math.abs(x1 - x2);
        const pdfHeight = Math.abs(y1 - y2);

        // 3. Clean Field Identifier
        const rawName = fieldNameInput.value.trim() || `Field_${Date.now()}`;
        const cleanName = rawName.replace(/[^a-zA-Z0-9_]/g, '_');

        // 4. Create Borderless, Black, Helvetica 12 Field
        const textField = form.createTextField(cleanName);
        textField.addToPage(page, {
            x: pdfX,
            y: pdfY,
            width: pdfWidth,
            height: pdfHeight,
            borderWidth: 0,              // Eliminates visible box outline
            textColor: rgb(0, 0, 0),     // Solid black text
            rotate: degrees(pageRotation) // Aligns text baseline with page orientation
        });

        textField.setFontSize(12);       // Sets 12pt Helvetica font scale

        // 5. Serialize and Trigger Download
        const modifiedPdfBytes = await pdfDoc.save();
        triggerDownload(modifiedPdfBytes, `${cleanName}_form.pdf`);

        selectionBox.style.display = 'none';
        boxCoords = { left: 0, top: 0, width: 0, height: 0 };
    } catch (err) {
        console.error(err);
        alert(`Failed to inject field: ${err.message}`);
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
