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

// Full-Page Studio Elements
const formWorkspace = document.getElementById('formWorkspace');
const btnExitEditor = document.getElementById('btnExitEditor');
const editorDropZone = document.getElementById('editorDropZone');
const editorFileInput = document.getElementById('editorFileInput');
const canvasViewport = document.getElementById('canvasViewport');
const canvasWrapper = document.getElementById('canvasWrapper');
const fieldNameInput = document.getElementById('fieldNameInput');
const btnApplyField = document.getElementById('btnApplyField');
const btnOpenBatch = document.getElementById('btnOpenBatch');
const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const zoomLabel = document.getElementById('zoomLabel');
const canvas = document.getElementById('pdfCanvas');
const selectionBox = document.getElementById('selectionBox');

// Batch Modal Elements
const batchModal = document.getElementById('batchModal');
const btnBatchClose = document.getElementById('btnBatchClose');
const btnBatchCancel = document.getElementById('btnBatchCancel');
const btnBatchExecute = document.getElementById('btnBatchExecute');
const batchSummaryName = document.getElementById('batchSummaryName');
const batchDropZone = document.getElementById('batchDropZone');
const batchFileInput = document.getElementById('batchFileInput');
const batchCountLabel = document.getElementById('batchCountLabel');
const btnClearBatch = document.getElementById('btnClearBatch');
const batchFileList = document.getElementById('batchFileList');
const batchZipInput = document.getElementById('batchZipInput');
const batchProgressContainer = document.getElementById('batchProgressContainer');
const batchProgressBarFill = document.getElementById('batchProgressBarFill');
const batchStatusText = document.getElementById('batchStatusText');

// --- APP STATE ---
let selectedFiles = [];
let appMode = 'MERGE';
let dragStartIndex;

// Cached Template PDF State
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

// Batch Queue State
let batchTargetFiles = [];

// PDF.js Worker Configuration
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// Local Loader for pdf-lib
async function getPDFLib() {
    if (window.PDFLib) return window.PDFLib;
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = './pdf-lib.min.js';
        s.onload = () => {
            if (window.PDFLib) resolve(window.PDFLib);
            else reject(new Error("Local pdf-lib.min.js loaded but PDFLib global not found."));
        };
        s.onerror = () => reject(new Error("Failed to load ./pdf-lib.min.js from root directory."));
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
    if (appMode === 'SPLIT') selectedFiles = [newFiles[0]];
    else selectedFiles = [...selectedFiles, ...newFiles];
    renderFileList();
}

async function handleFormFile(file) {
    if (!file || file.type !== 'application/pdf') return;

    cleanupPdfDoc();
    rawFormPdfBuffer = await file.arrayBuffer();
    currentZoom = 2.0;

    editorDropZone.style.display = 'none';
    canvasWrapper.style.display = 'block';

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

// --- FAST CANVAS RENDERING ---
async function renderCachedPage() {
    if (!loadedPdfPage) return;

    if (currentRenderTask) {
        currentRenderTask.cancel();
        try { await currentRenderTask.promise; } catch (e) {}
        currentRenderTask = null;
    }

    btnZoomIn.disabled = true;
    btnZoomOut.disabled = true;
    zoomLabel.innerText = `${Math.round(currentZoom * 100)}%`;

    const oldScale = totalRenderScale;
    const newScale = (96 / 72) * currentZoom;

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

// --- ZOOM CONTROLS ---
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
        if (!isSpacePressed) canvasViewport.classList.remove('panning-ready', 'is-panning');
        else canvasViewport.classList.remove('is-panning');
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

// --- HELPER: GET CURRENT FIELD GEOMETRY IN PDF POINTS ---
function getFieldGeometry() {
    if (!loadedPdfPage || boxCoords.width < 5 || boxCoords.height < 5) return null;

    const viewport = loadedPdfPage.getViewport({ scale: totalRenderScale });
    const [x1, y1] = viewport.convertToPdfPoint(boxCoords.left, boxCoords.top);
    const [x2, y2] = viewport.convertToPdfPoint(
        boxCoords.left + boxCoords.width, 
        boxCoords.top + boxCoords.height
    );

    return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x1 - x2),
        height: Math.abs(y1 - y2),
        pageRotation: loadedPdfPage.rotate || 0,
        name: (fieldNameInput.value.trim() || `Field_${Date.now()}`).replace(/[^a-zA-Z0-9_]/g, '_')
    };
}

// --- SINGLE FILE ACROFORM INJECTION ---
btnApplyField.addEventListener('click', async () => {
    if (!rawFormPdfBuffer) {
        alert("Please load a PDF document first.");
        return;
    }
    const geom = getFieldGeometry();
    if (!geom) {
        alert("Please draw and position a field box on the document.");
        return;
    }

    try {
        const lib = await getPDFLib();
        const { PDFDocument, rgb, degrees } = lib;
        const pdfDoc = await PDFDocument.load(rawFormPdfBuffer.slice(0));
        const page = pdfDoc.getPages()[0];
        const form = pdfDoc.getForm();

        page.setRotation(degrees(geom.pageRotation));

        const textField = form.createTextField(geom.name);
        textField.addToPage(page, {
            x: geom.x,
            y: geom.y,
            width: geom.width,
            height: geom.height,
            borderWidth: 0,
            textColor: rgb(0, 0, 0),
            rotate: degrees(geom.pageRotation)
        });
        textField.setFontSize(12);

        const modifiedPdfBytes = await pdfDoc.save();
        triggerDownload(modifiedPdfBytes, `${geom.name}_form.pdf`, 'application/pdf');

        selectionBox.style.display = 'none';
        boxCoords = { left: 0, top: 0, width: 0, height: 0 };
    } catch (err) {
        console.error(err);
        alert(`Failed to inject field: ${err.message}`);
    }
});

// --- BATCH PROCESSING LOGIC ---
btnOpenBatch.addEventListener('click', () => {
    if (!rawFormPdfBuffer) {
        alert("Please load a template PDF placard first.");
        return;
    }
    const geom = getFieldGeometry();
    if (!geom) {
        alert("Please draw and position the field box on the template document first.");
        return;
    }

    batchSummaryName.innerText = geom.name;
    batchModal.style.display = 'flex';
    renderBatchFileList();
});

btnBatchClose.onclick = () => { batchModal.style.display = 'none'; };
btnBatchCancel.onclick = () => { batchModal.style.display = 'none'; };

// Batch Drag-and-Drop & File Selection
batchDropZone.addEventListener('dragover', (e) => { e.preventDefault(); batchDropZone.classList.add('dragover'); });
batchDropZone.addEventListener('dragleave', () => batchDropZone.classList.remove('dragover'));
batchDropZone.addEventListener('click', () => batchFileInput.click());

batchDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    batchDropZone.classList.remove('dragover');
    addBatchFiles(e.dataTransfer.files);
});

batchFileInput.addEventListener('change', (e) => {
    addBatchFiles(e.target.files);
});

function addBatchFiles(fileListObj) {
    const newFiles = Array.from(fileListObj).filter(f => f.type === 'application/pdf');
    batchTargetFiles = [...batchTargetFiles, ...newFiles];
    renderBatchFileList();
}

btnClearBatch.addEventListener('click', () => {
    batchTargetFiles = [];
    renderBatchFileList();
});

function renderBatchFileList() {
    batchFileList.innerHTML = '';
    batchTargetFiles.forEach((f, idx) => {
        const item = document.createElement('div');
        item.className = 'batch-file-item';
        item.innerHTML = `
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px;">${idx + 1}. ${f.name}</span>
            <span style="cursor: pointer; color: #f85149; font-weight: bold; margin-left: 8px;" onclick="window.removeBatchItem(${idx})">&times;</span>
        `;
        batchFileList.appendChild(item);
    });

    batchCountLabel.innerText = `${batchTargetFiles.length} FILES QUEUED`;
    btnClearBatch.style.display = batchTargetFiles.length > 0 ? 'inline-block' : 'none';
    btnBatchExecute.disabled = batchTargetFiles.length === 0;
    btnBatchExecute.style.opacity = batchTargetFiles.length > 0 ? '1' : '0.5';
}

window.removeBatchItem = (index) => {
    batchTargetFiles.splice(index, 1);
    renderBatchFileList();
};

// Batch Execution Engine
btnBatchExecute.addEventListener('click', async () => {
    const geom = getFieldGeometry();
    if (!geom || batchTargetFiles.length === 0) return;

    btnBatchExecute.disabled = true;
    btnBatchCancel.disabled = true;
    batchProgressContainer.style.display = 'block';

    try {
        const lib = await getPDFLib();
        const { PDFDocument, rgb, degrees } = lib;
        const processedZipEntries = [];
        const total = batchTargetFiles.length;

        for (let i = 0; i < total; i++) {
            const file = batchTargetFiles[i];
            const pct = Math.round(((i + 1) / total) * 100);
            batchProgressBarFill.style.width = `${pct}%`;
            batchStatusText.innerText = `Processing ${i + 1} of ${total}: ${file.name}`;

            // Yield to browser to keep animation smooth
            await new Promise(r => setTimeout(r, 10));

            const arrayBuffer = await file.arrayBuffer();
            const pdfDoc = await PDFDocument.load(arrayBuffer);
            const page = pdfDoc.getPages()[0];
            const form = pdfDoc.getForm();

            // Match rotation of this specific target document
            const targetRotation = page.getRotation().angle;
            page.setRotation(degrees(targetRotation));

            const textField = form.createTextField(geom.name);
            textField.addToPage(page, {
                x: geom.x,
                y: geom.y,
                width: geom.width,
                height: geom.height,
                borderWidth: 0,
                textColor: rgb(0, 0, 0),
                rotate: degrees(targetRotation)
            });
            textField.setFontSize(12);

            const modifiedBytes = await pdfDoc.save();
            const outName = file.name.replace(/\.pdf$/i, '_form.pdf');
            processedZipEntries.push({ name: outName, data: modifiedBytes });
        }

        batchStatusText.innerText = `Compressing ${total} files into ZIP...`;
        await new Promise(r => setTimeout(r, 20));

        // Generate uncompressed standard ZIP in-memory
        const zipBytes = createStoreZip(processedZipEntries);
        const zipFilename = batchZipInput.value.trim() || 'batch_placards_forms.zip';
        triggerDownload(zipBytes, zipFilename, 'application/zip');

        batchStatusText.innerText = `Complete! Download triggered.`;
        setTimeout(() => {
            batchModal.style.display = 'none';
            batchProgressContainer.style.display = 'none';
            btnBatchExecute.disabled = false;
            btnBatchCancel.disabled = false;
            batchTargetFiles = [];
            renderBatchFileList();
        }, 1200);

    } catch (err) {
        console.error(err);
        alert(`Batch execution failed: ${err.message}`);
        btnBatchExecute.disabled = false;
        btnBatchCancel.disabled = false;
    }
});

// --- ZERO-DEPENDENCY PURE JS ZIP GENERATOR ---
function createStoreZip(files) {
    const crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[i] = c >>> 0;
    }

    function getCrc32(buf) {
        let crc = 0 ^ (-1);
        for (let i = 0; i < buf.length; i++) {
            crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
        }
        return (crc ^ (-1)) >>> 0;
    }

    const encoder = new TextEncoder();
    const entries = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const dataBytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
        const crc = getCrc32(dataBytes);
        const size = dataBytes.length;

        entries.push({ nameBytes, dataBytes, crc, size, offset });
        offset += 30 + nameBytes.length + size;
    }

    const centralDirOffset = offset;
    let centralDirSize = 0;
    for (const e of entries) {
        centralDirSize += 46 + e.nameBytes.length;
    }

    const totalZipSize = centralDirOffset + centralDirSize + 22;
    const zipBuffer = new Uint8Array(totalZipSize);
    const view = new DataView(zipBuffer.buffer);

    let pos = 0;

    // Local headers + payload
    for (const e of entries) {
        view.setUint32(pos, 0x04034b50, true); pos += 4;
        view.setUint16(pos, 20, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2; // Stored (0% compression)
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint32(pos, e.crc, true); pos += 4;
        view.setUint32(pos, e.size, true); pos += 4;
        view.setUint32(pos, e.size, true); pos += 4;
        view.setUint16(pos, e.nameBytes.length, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;

        zipBuffer.set(e.nameBytes, pos); pos += e.nameBytes.length;
        zipBuffer.set(e.dataBytes, pos); pos += e.dataBytes.length;
    }

    // Central directory
    for (const e of entries) {
        view.setUint32(pos, 0x02014b50, true); pos += 4;
        view.setUint16(pos, 20, true); pos += 2;
        view.setUint16(pos, 20, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint32(pos, e.crc, true); pos += 4;
        view.setUint32(pos, e.size, true); pos += 4;
        view.setUint32(pos, e.size, true); pos += 4;
        view.setUint16(pos, e.nameBytes.length, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint16(pos, 0, true); pos += 2;
        view.setUint32(pos, 0, true); pos += 4;
        view.setUint32(pos, e.offset, true); pos += 4;

        zipBuffer.set(e.nameBytes, pos); pos += e.nameBytes.length;
    }

    // End of Central Directory
    view.setUint32(pos, 0x06054b50, true); pos += 4;
    view.setUint16(pos, 0, true); pos += 2;
    view.setUint16(pos, 0, true); pos += 2;
    view.setUint16(pos, entries.length, true); pos += 2;
    view.setUint16(pos, entries.length, true); pos += 2;
    view.setUint32(pos, centralDirSize, true); pos += 4;
    view.setUint32(pos, centralDirOffset, true); pos += 4;
    view.setUint16(pos, 0, true); pos += 2;

    return zipBuffer;
}

function triggerDownload(uint8Array, filename, mimeType) {
    const blob = new Blob([uint8Array], { type: mimeType });
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
