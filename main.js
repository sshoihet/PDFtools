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

// Full-Page Studio
const formWorkspace = document.getElementById('formWorkspace');
const btnExitEditor = document.getElementById('btnExitEditor');
const editorDropZone = document.getElementById('editorDropZone');
const editorFileInput = document.getElementById('editorFileInput');
const canvasViewport = document.getElementById('canvasViewport');
const canvasWrapper = document.getElementById('canvasWrapper');
const btnOpenBatch = document.getElementById('btnOpenBatch');
const btnExportPdf = document.getElementById('btnExportPdf');
const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const zoomLabel = document.getElementById('zoomLabel');
const canvas = document.getElementById('pdfCanvas');
const selectionBox = document.getElementById('selectionBox');
const stagedBoxesLayer = document.getElementById('stagedBoxesLayer');

// Sidebar Inspector
const btnNewField = document.getElementById('btnNewField');
const sidebarEmptyState = document.getElementById('sidebarEmptyState');
const sidebarFieldControls = document.getElementById('sidebarFieldControls');
const fieldNameInput = document.getElementById('fieldNameInput');
const fieldFontSize = document.getElementById('fieldFontSize');
const fieldFontFamily = document.getElementById('fieldFontFamily');
const fieldAlignment = document.getElementById('fieldAlignment');
const fieldColor = document.getElementById('fieldColor');
const btnDeleteField = document.getElementById('btnDeleteField');
const fieldsList = document.getElementById('fieldsList');

// Batch Modal
const batchModal = document.getElementById('batchModal');
const btnBatchClose = document.getElementById('btnBatchClose');
const btnBatchCancel = document.getElementById('btnBatchCancel');
const btnBatchExecute = document.getElementById('btnBatchExecute');
const batchSummaryInfo = document.getElementById('batchSummaryInfo');
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
let rawFormFileName = '';
let loadedPdfDoc = null;
let loadedPdfPage = null;

let currentZoom = 2.0;
let totalRenderScale = 0;
let currentRenderTask = null;

// Multi-Field Pipeline State
// vx, vy, vw, vh are stored in unscaled PDF points (1/72 in) measured from the VISUAL top-left corner
let stagedFields = [];
let activeFieldId = null;

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

// Interaction Buffers (Screen pixels on the active canvas)
let boxCoords = { left: 0, top: 0, width: 0, height: 0 };
let origBox = { left: 0, top: 0, width: 0, height: 0 };
let dragStart = { x: 0, y: 0 };
let activeHandle = null;
let panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };

// Batch Queue State
let batchTargetFiles = [];

// PDF.js Worker Setup
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
    rawFormFileName = '';
    cleanupPdfDoc();
    stagedFields = [];
    activeFieldId = null;
    currentZoom = 2.0;

    renderFileList();
    resetCanvas();
    syncSidebar();

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

// --- FILE INPUT HANDLING (Standard Modes) ---
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});

// --- FILE INPUT HANDLING (Studio Template Placard) ---
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
    rawFormFileName = file.name;
    rawFormPdfBuffer = await file.arrayBuffer();
    stagedFields = [];
    activeFieldId = null;
    currentZoom = 2.0;

    editorDropZone.style.display = 'none';
    canvasWrapper.style.display = 'block';

    const loadingTask = pdfjsLib.getDocument({ data: rawFormPdfBuffer.slice(0) });
    loadedPdfDoc = await loadingTask.promise;
    loadedPdfPage = await loadedPdfDoc.getPage(1);

    totalRenderScale = (96 / 72) * currentZoom;
    await renderCachedPage();
    syncSidebar();
}

function cleanupPdfDoc() {
    if (loadedPdfDoc) {
        loadedPdfDoc.destroy();
        loadedPdfDoc = null;
        loadedPdfPage = null;
    }
}

// --- FAST CANVAS RENDERING & STAGED BOX RE-PROJECTION ---
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

    totalRenderScale = (96 / 72) * currentZoom;

    try {
        const viewport = loadedPdfPage.getViewport({ scale: totalRenderScale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        currentRenderTask = loadedPdfPage.render({ canvasContext: ctx, viewport: viewport });
        await currentRenderTask.promise;

        // Project invariant visual PDF points back to screen pixels on new canvas scale
        renderStagedBoxesDOM();
        updateActiveSelectionBox();
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
    stagedBoxesLayer.innerHTML = '';
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
    if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') {
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
    const isSelectionBox = e.target === selectionBox;
    const placedBoxEl = e.target.closest('.placed-field-box');
    const canvasRect = canvas.getBoundingClientRect();

    dragStart = { x: e.clientX, y: e.clientY };
    origBox = { ...boxCoords };

    if (handleEl) {
        currentMode = InteractionMode.RESIZING;
        activeHandle = handleEl.dataset.handle;
        e.stopPropagation();
    } else if (isSelectionBox) {
        currentMode = InteractionMode.MOVING;
        e.stopPropagation();
    } else if (placedBoxEl) {
        // Select an existing placed field
        const id = placedBoxEl.dataset.id;
        setActiveField(id);
        currentMode = InteractionMode.MOVING;
        origBox = { ...boxCoords };
        e.stopPropagation();
    } else if (e.target === canvas) {
        // Start drawing a fresh box
        currentMode = InteractionMode.DRAWING;
        const startX = Math.max(0, Math.min(e.clientX - canvasRect.left, canvas.width));
        const startY = Math.max(0, Math.min(e.clientY - canvasRect.top, canvas.height));

        boxCoords = { left: startX, top: startY, width: 0, height: 0 };
        activeFieldId = null;
        renderStagedBoxesDOM();
        updateSelectionBoxDOM();
        syncSidebar();
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
        if (boxCoords.width >= 12 && boxCoords.height >= 12 && totalRenderScale > 0) {
            // Commit new field using invariant visual PDF point coordinates
            const newId = `field_${Date.now()}`;
            const count = stagedFields.length + 1;
            const newField = {
                id: newId,
                name: `Field_${count}`,
                vx: boxCoords.left / totalRenderScale,
                vy: boxCoords.top / totalRenderScale,
                vw: boxCoords.width / totalRenderScale,
                vh: boxCoords.height / totalRenderScale,
                fontSize: 12,
                fontFamily: 'Helvetica',
                alignment: 'Left',
                color: 'black'
            };
            stagedFields.push(newField);
            setActiveField(newId);
            fieldNameInput.focus();
            fieldNameInput.select();
        } else {
            selectionBox.style.display = 'none';
        }
    } else if (currentMode === InteractionMode.MOVING || currentMode === InteractionMode.RESIZING) {
        const active = getActiveField();
        if (active && totalRenderScale > 0) {
            active.vx = boxCoords.left / totalRenderScale;
            active.vy = boxCoords.top / totalRenderScale;
            active.vw = boxCoords.width / totalRenderScale;
            active.vh = boxCoords.height / totalRenderScale;
            renderStagedBoxesDOM();
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

// --- STAGED BOX RENDERING & SELECTION ---
function renderStagedBoxesDOM() {
    stagedBoxesLayer.innerHTML = '';
    stagedFields.forEach((f) => {
        if (f.id === activeFieldId) return;

        const left = f.vx * totalRenderScale;
        const top = f.vy * totalRenderScale;
        const width = f.vw * totalRenderScale;
        const height = f.vh * totalRenderScale;

        const el = document.createElement('div');
        el.className = 'placed-field-box';
        el.dataset.id = f.id;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;

        const label = document.createElement('div');
        label.className = 'placed-field-label';
        label.innerText = f.name;
        el.appendChild(label);

        stagedBoxesLayer.appendChild(el);
    });
}

function updateActiveSelectionBox() {
    const active = getActiveField();
    if (!active || totalRenderScale <= 0) {
        selectionBox.style.display = 'none';
        return;
    }
    boxCoords = {
        left: active.vx * totalRenderScale,
        top: active.vy * totalRenderScale,
        width: active.vw * totalRenderScale,
        height: active.vh * totalRenderScale
    };
    updateSelectionBoxDOM();
}

function getActiveField() {
    return stagedFields.find(f => f.id === activeFieldId);
}

function setActiveField(id) {
    activeFieldId = id;
    renderStagedBoxesDOM();
    updateActiveSelectionBox();
    syncSidebar();
}

// --- SIDEBAR SYNCHRONIZATION ---
function syncSidebar() {
    const count = stagedFields.length;
    btnExportPdf.innerText = `EXPORT PDF (${count} FIELD${count === 1 ? '' : 'S'})`;
    btnExportPdf.disabled = count === 0;
    btnExportPdf.style.opacity = count > 0 ? '1' : '0.5';

    btnOpenBatch.innerText = `BATCH APPLY (${count})...`;
    btnOpenBatch.disabled = count === 0;
    btnOpenBatch.style.opacity = count > 0 ? '1' : '0.5';

    const active = getActiveField();

    if (!active) {
        sidebarEmptyState.style.display = 'block';
        sidebarFieldControls.style.display = 'none';
    } else {
        sidebarEmptyState.style.display = 'none';
        sidebarFieldControls.style.display = 'flex';

        fieldNameInput.value = active.name;
        fieldFontSize.value = active.fontSize;
        fieldFontFamily.value = active.fontFamily;
        fieldAlignment.value = active.alignment;
        fieldColor.value = active.color;
    }

    // Render Layer List
    fieldsList.innerHTML = '';
    stagedFields.forEach((f, idx) => {
        const item = document.createElement('div');
        item.className = `field-list-item ${f.id === activeFieldId ? 'selected' : ''}`;
        item.innerHTML = `
            <span>${idx + 1}. ${f.name}</span>
            <span class="field-meta-tag">${f.fontFamily} ${f.fontSize}pt</span>
        `;
        item.onclick = () => setActiveField(f.id);
        fieldsList.appendChild(item);
    });
}

// Live Inspector Input Handlers
fieldNameInput.addEventListener('input', (e) => {
    const active = getActiveField();
    if (!active) return;
    active.name = e.target.value.trim().replace(/[^a-zA-Z0-9_]/g, '_') || 'Field';
    renderStagedBoxesDOM();
    syncSidebar();
});

fieldFontSize.addEventListener('change', (e) => {
    const active = getActiveField();
    if (active) { active.fontSize = parseInt(e.target.value, 10); syncSidebar(); }
});

fieldFontFamily.addEventListener('change', (e) => {
    const active = getActiveField();
    if (active) { active.fontFamily = e.target.value; syncSidebar(); }
});

fieldAlignment.addEventListener('change', (e) => {
    const active = getActiveField();
    if (active) { active.alignment = e.target.value; syncSidebar(); }
});

fieldColor.addEventListener('change', (e) => {
    const active = getActiveField();
    if (active) { active.color = e.target.value; syncSidebar(); }
});

btnDeleteField.addEventListener('click', () => {
    if (!activeFieldId) return;
    stagedFields = stagedFields.filter(f => f.id !== activeFieldId);
    activeFieldId = stagedFields.length > 0 ? stagedFields[stagedFields.length - 1].id : null;
    renderStagedBoxesDOM();
    updateActiveSelectionBox();
    syncSidebar();
});

btnNewField.addEventListener('click', () => {
    activeFieldId = null;
    selectionBox.style.display = 'none';
    renderStagedBoxesDOM();
    syncSidebar();
});

// --- UNIFIED ACROFORM INJECTION ENGINE (TOP-LEFT ANCHOR + BORDER PURGE) ---
function applyFieldToPage(form, page, fieldDef, pdfDoc, lib, fontMap, colorMap, alignmentMap) {
    const { PDFName, rgb, degrees } = lib;
    const rotationAngle = page.getRotation().angle || 0;
    const pageX = page.getX();
    const pageY = page.getY();
    const pageW = page.getWidth();
    const pageH = page.getHeight();

    const { vx, vy, vw, vh, name, fontSize, fontFamily, alignment, color } = fieldDef;

    let pdfX, pdfY, pdfWidth, pdfHeight;

    // Map visual top-left coordinates to native PDF coordinates based on rotation
    switch (rotationAngle) {
        case 90:
            pdfX = pageX + vy;
            pdfY = pageY + vx;
            pdfWidth = vh;
            pdfHeight = vw;
            break;
        case 180:
            pdfX = pageX + pageW - vx - vw;
            pdfY = pageY + vy;
            pdfWidth = vw;
            pdfHeight = vh;
            break;
        case 270:
            pdfX = pageX + pageW - vy - vh;
            pdfY = pageY + pageH - vx - vw;
            pdfWidth = vh;
            pdfHeight = vw;
            break;
        case 0:
        default:
            pdfX = pageX + vx;
            pdfY = pageY + pageH - vy - vh;
            pdfWidth = vw;
            pdfHeight = vh;
            break;
    }

    page.setRotation(degrees(rotationAngle));

    const textField = form.createTextField(name);
    textField.addToPage(page, {
        x: pdfX,
        y: pdfY,
        width: pdfWidth,
        height: pdfHeight,
        borderWidth: 0,
        textColor: colorMap[color] || rgb(0, 0, 0),
        rotate: degrees(rotationAngle)
    });

    textField.setFontSize(fontSize || 12);
    textField.setAlignment(alignmentMap[alignment] || lib.TextAlignment.Left);

    const font = fontMap[fontFamily];
    if (font) {
        textField.updateAppearances(font);
    }

    // Tri-Level Border Purge (strips annotation /Border, /BS, and /MK /BC flags)
    const widgets = textField.acroField.getWidgets();
    for (const widget of widgets) {
        widget.dict.set(PDFName.of('Border'), pdfDoc.context.obj([0, 0, 0]));
        
        if (widget.getOrCreateBorderStyle) {
            const bs = widget.getOrCreateBorderStyle();
            bs.setWidth(0);
        }

        const mk = widget.dict.lookup(PDFName.of('MK'));
        if (mk && typeof mk.delete === 'function') {
            mk.delete(PDFName.of('BC'));
            mk.delete(PDFName.of('BG'));
        }
    }

    return textField;
}

// --- SINGLE-FILE MULTI-FIELD EXPORT ---
btnExportPdf.addEventListener('click', async () => {
    if (!rawFormPdfBuffer) {
        alert("Please load a PDF document first.");
        return;
    }
    if (stagedFields.length === 0) {
        alert("Please draw and position at least one field on the document.");
        return;
    }

    try {
        const lib = await getPDFLib();
        const { PDFDocument, rgb, StandardFonts, TextAlignment } = lib;
        const pdfDoc = await PDFDocument.load(rawFormPdfBuffer.slice(0));
        const page = pdfDoc.getPages()[0];
        const form = pdfDoc.getForm();

        const fontMap = {
            'Helvetica': await pdfDoc.embedFont(StandardFonts.Helvetica),
            'TimesRoman': await pdfDoc.embedFont(StandardFonts.TimesRoman),
            'Courier': await pdfDoc.embedFont(StandardFonts.Courier)
        };

        const colorMap = {
            'black': rgb(0, 0, 0),
            'blue': rgb(0.08, 0.38, 0.74),
            'red': rgb(0.85, 0.15, 0.15)
        };

        const alignmentMap = {
            'Left': TextAlignment.Left,
            'Center': TextAlignment.Center,
            'Right': TextAlignment.Right
        };

        // Inject all staged fields in a single pass
        stagedFields.forEach((field) => {
            applyFieldToPage(form, page, field, pdfDoc, lib, fontMap, colorMap, alignmentMap);
        });

        const modifiedPdfBytes = await pdfDoc.save();
        const baseName = (rawFormFileName || 'placard').replace(/\.pdf$/i, '');
        triggerDownload(modifiedPdfBytes, `${baseName}_fillable.pdf`, 'application/pdf');

    } catch (err) {
        console.error(err);
        alert(`Failed to export PDF: ${err.message}`);
    }
});

// --- BATCH PROCESSING LOGIC ---
btnOpenBatch.addEventListener('click', () => {
    if (!rawFormPdfBuffer) {
        alert("Please load a template PDF placard first.");
        return;
    }
    if (stagedFields.length === 0) {
        alert("Please draw and configure at least one field on the template document first.");
        return;
    }

    batchSummaryInfo.innerText = `${stagedFields.length} Field${stagedFields.length === 1 ? '' : 's'} Configured`;
    batchModal.style.display = 'flex';
    renderBatchFileList();
});

btnBatchClose.onclick = () => { batchModal.style.display = 'none'; };
btnBatchCancel.onclick = () => { batchModal.style.display = 'none'; };

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

btnBatchExecute.addEventListener('click', async () => {
    if (stagedFields.length === 0 || batchTargetFiles.length === 0) return;

    btnBatchExecute.disabled = true;
    btnBatchCancel.disabled = true;
    batchProgressContainer.style.display = 'block';

    try {
        const lib = await getPDFLib();
        const { PDFDocument, rgb, StandardFonts, TextAlignment } = lib;
        const processedZipEntries = [];
        const total = batchTargetFiles.length;

        const colorMap = {
            'black': rgb(0, 0, 0),
            'blue': rgb(0.08, 0.38, 0.74),
            'red': rgb(0.85, 0.15, 0.15)
        };

        const alignmentMap = {
            'Left': TextAlignment.Left,
            'Center': TextAlignment.Center,
            'Right': TextAlignment.Right
        };

        for (let i = 0; i < total; i++) {
            const file = batchTargetFiles[i];
            const pct = Math.round(((i + 1) / total) * 100);
            batchProgressBarFill.style.width = `${pct}%`;
            batchStatusText.innerText = `Processing ${i + 1} of ${total}: ${file.name}`;

            await new Promise(r => setTimeout(r, 10));

            const arrayBuffer = await file.arrayBuffer();
            const pdfDoc = await PDFDocument.load(arrayBuffer);
            const page = pdfDoc.getPages()[0];
            const form = pdfDoc.getForm();

            const fontMap = {
                'Helvetica': await pdfDoc.embedFont(StandardFonts.Helvetica),
                'TimesRoman': await pdfDoc.embedFont(StandardFonts.TimesRoman),
                'Courier': await pdfDoc.embedFont(StandardFonts.Courier)
            };

            // Apply all staged fields to this specific batch document
            stagedFields.forEach((field) => {
                applyFieldToPage(form, page, field, pdfDoc, lib, fontMap, colorMap, alignmentMap);
            });

            const modifiedBytes = await pdfDoc.save();
            const outName = file.name.replace(/\.pdf$/i, '_fillable.pdf');
            processedZipEntries.push({ name: outName, data: modifiedBytes });
        }

        batchStatusText.innerText = `Compressing ${total} files into ZIP...`;
        await new Promise(r => setTimeout(r, 20));

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

    for (const e of entries) {
        view.setUint32(pos, 0x04034b50, true); pos += 4;
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

        zipBuffer.set(e.nameBytes, pos); pos += e.nameBytes.length;
        zipBuffer.set(e.dataBytes, pos); pos += e.dataBytes.length;
    }

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
