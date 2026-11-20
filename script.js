const GRID_SIZE = 120;
const DRAG_THRESHOLD = 5;

// The backend holds every secret (S3 credentials, upstream tokens). The only
// thing this extension ever stores is the per-machine role token, entered
// once in the setup modal and kept in chrome.storage.local - never in code,
// never in the repo. The hostname is not a secret.
const API_BASE = 'https://newtab.ivikkk.xyz';
const AIR_UPDATE_INTERVAL = 15 * 60 * 1000;
const SYNC_DEBOUNCE_MS = 1500;

let apiToken = null;
let role = null; // 'master' | 'corp' | null while offline/unconfigured

let draggedElement = null;
let startX, startY;
let currentX, currentY;
let editKey = null;
let dragThreshold = false;
let isDragging = false;

let currentFolderPath = [];
let typedNumber = '';
let numberInputTimeout = null;
let bookmarkNumberMap = {};
let syncTimer = null;
let lockMode = false; // master-only: preview the corp view, click items to toggle locks
const iconObjectUrls = new Map(); // iconKey -> objectURL cache for this page

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('addBookmarkBtn').addEventListener('click', openBookmarkModal);
    document.getElementById('saveBtn').addEventListener('click', saveBookmark);
    document.getElementById('cancelBtn').addEventListener('click', closeBookmarkModal);
    document.getElementById('deleteBtn').addEventListener('click', deleteBookmark);

    document.getElementById('syncBtn').addEventListener('click', () => syncToServer({ showFeedback: true }));
    document.getElementById('wallpaperBtn').addEventListener('click', openWallpaperModal);
    document.getElementById('wallpaperCloseBtn').addEventListener('click', closeWallpaperModal);
    document.getElementById('wallpaperFile').addEventListener('change', (e) => {
        if (e.target.files[0]) uploadWallpaperFile(e.target.files[0]);
        e.target.value = '';
    });
    document.getElementById('historyBtn').addEventListener('click', openHistoryModal);
    document.getElementById('historyCloseBtn').addEventListener('click', closeHistoryModal);
    document.getElementById('lockModeBtn').addEventListener('click', toggleLockMode);
    document.getElementById('setupSaveBtn').addEventListener('click', saveSetupToken);

    document.getElementById('searchInput').addEventListener('input', (e) => {
        renderSearchResults(e.target.value);
    });

    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            closeBookmarkModal();
            clearNumberInput();
            closeSearchOverlay();
            closeHistoryModal();
            closeWallpaperModal();
            if (lockMode) toggleLockMode();
        } else if (event.key === 'Enter' &&
            document.getElementById('setupModal').style.display === 'flex') {
            saveSetupToken();
        } else if (event.key === 'Enter' &&
            document.getElementById('bookmarkModal').style.display === 'flex') {
            saveBookmark();
        } else if (event.key === 'Enter' &&
            document.getElementById('searchOverlay').style.display === 'flex') {
            selectFirstSearchResult();
        } else if (event.key === 'Enter' && typedNumber) {
            navigateToNumber(parseInt(typedNumber));
            clearNumberInput();
        } else if (event.key === 'Backspace' && typedNumber &&
            document.getElementById('bookmarkModal').style.display !== 'flex' &&
            document.getElementById('searchOverlay').style.display !== 'flex') {
            event.preventDefault();
            typedNumber = typedNumber.slice(0, -1);
            updateNumberDisplay();
        } else if (/^[0-9]$/.test(event.key) &&
            document.getElementById('bookmarkModal').style.display !== 'flex' &&
            document.getElementById('searchOverlay').style.display !== 'flex' &&
            document.activeElement.tagName !== 'INPUT') {
            typedNumber += event.key;
            updateNumberDisplay();
        } else if ((event.key === 'p' || event.key === 'P') &&
            document.getElementById('bookmarkModal').style.display !== 'flex' &&
            document.getElementById('searchOverlay').style.display !== 'flex' &&
            document.activeElement.tagName !== 'INPUT') {
            event.preventDefault();
            openSearchOverlay();
        }
    });

    document.getElementById('bookmarkType').addEventListener('click', () => switchType('bookmark'));
    document.getElementById('folderType').addEventListener('click', () => switchType('folder'));
    document.getElementById('iconUrlMode').addEventListener('click', () => switchIconMode('url'));
    document.getElementById('iconFileMode').addEventListener('click', () => switchIconMode('file'));

    loadBookmarks(); // render cache instantly; server refresh follows
    bootstrap();
});

// ---- config + server bootstrap ----

function apiHeaders(extra) {
    return { 'Authorization': `Bearer ${apiToken}`, ...extra };
}

async function bootstrap() {
    const stored = await chrome.storage.local.get('apiToken');
    if (!stored.apiToken) {
        document.getElementById('setupModal').style.display = 'flex';
        return;
    }
    apiToken = stored.apiToken;
    applyStoredWallpaper(); // wallpaper and bookmarks load in parallel
    await refreshFromServer();
}

async function saveSetupToken() {
    const input = document.getElementById('setupToken');
    const errorEl = document.getElementById('setupError');
    const token = input.value.trim();
    if (!token) return;
    try {
        const response = await fetch(`${API_BASE}/newtab/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) {
            errorEl.textContent = response.status === 401 ? 'Token rejected.' : `Server error (${response.status}).`;
            return;
        }
        await chrome.storage.local.set({ apiToken: token });
        apiToken = token;
        input.value = '';
        errorEl.textContent = '';
        document.getElementById('setupModal').style.display = 'none';
        applyStoredWallpaper();
        await refreshFromServer();
    } catch (err) {
        errorEl.textContent = 'Could not reach the server.';
    }
}

async function refreshFromServer() {
    if (!apiToken) return;
    try {
        const response = await fetch(`${API_BASE}/newtab/data`, { headers: apiHeaders() });
        if (response.status === 401) {
            // Token revoked - drop it and ask again.
            await chrome.storage.local.remove('apiToken');
            apiToken = null;
            role = null;
            document.getElementById('setupModal').style.display = 'flex';
            return;
        }
        if (!response.ok) throw new Error(`data fetch failed: ${response.status}`);
        const payload = await response.json();
        role = payload.role;
        localStorage.setItem('customBookmarks', JSON.stringify(payload.data || {}));
        applyRoleUI();
        currentFolderPath = [];
        loadBookmarks();
        updateBackIndicator();
    } catch (err) {
        console.error('Offline or server unreachable - serving cached bookmarks:', err);
    }
}

function applyRoleUI() {
    const isMaster = role === 'master';
    document.getElementById('historyBtn').style.display = isMaster ? '' : 'none';
    document.getElementById('lockModeBtn').style.display = isMaster ? '' : 'none';
    document.getElementById('airQualityContainer').style.display = isMaster ? '' : 'none';
    if (isMaster && !applyRoleUI._airStarted) {
        applyRoleUI._airStarted = true;
        updateAirQuality();
        setInterval(updateAirQuality, AIR_UPDATE_INTERVAL);
    }
}

// ---- sync ----

function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncToServer({ showFeedback: false }), SYNC_DEBOUNCE_MS);
}

function flashSyncButton(success) {
    const btn = document.getElementById('syncBtn');
    btn.classList.remove('sync-success', 'sync-error');
    btn.classList.add(success ? 'sync-success' : 'sync-error');
    setTimeout(() => btn.classList.remove('sync-success', 'sync-error'), 1000);
}

// POSTs the local tree; the response carries the server's authoritative view
// (for corp that includes merge results - re-anchored locked placeholders,
// relocated collisions), which replaces the local cache.
async function syncToServer({ showFeedback, restoredFrom } = {}) {
    if (!apiToken) return;
    clearTimeout(syncTimer);
    try {
        const bookmarks = JSON.parse(localStorage.getItem('customBookmarks') || '{}');
        const response = await fetch(`${API_BASE}/newtab/sync`, {
            method: 'POST',
            headers: apiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ data: bookmarks, restoredFrom: restoredFrom || null }),
        });
        if (!response.ok) throw new Error('Sync request failed');
        const result = await response.json();
        if (result.data) {
            localStorage.setItem('customBookmarks', JSON.stringify(result.data));
            loadBookmarks();
        }
        if (showFeedback) flashSyncButton(true);
        return result;
    } catch (error) {
        console.error('Error syncing bookmarks:', error);
        if (showFeedback) flashSyncButton(false);
        throw error;
    }
}

// ---- rendering ----

function snapToGrid(value) {
    return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function createIconElement(item) {
    const iconContainer = document.createElement('div');
    iconContainer.className = 'bookmark-icon';

    const img = new Image();
    img.onerror = () => {
        iconContainer.className = 'bookmark-icon fallback';
        iconContainer.textContent = (item.name || '?').charAt(0).toUpperCase();
    };
    img.onload = () => {
        iconContainer.innerHTML = '';
        iconContainer.appendChild(img);
    };

    if (item.iconKey) {
        const cached = iconObjectUrls.get(item.iconKey);
        if (cached) {
            img.src = cached;
        } else {
            const keyPart = item.iconKey.replace(/^icons\//, '');
            fetch(`${API_BASE}/newtab/icons/${keyPart}`, { headers: apiHeaders() })
                .then((r) => { if (!r.ok) throw new Error('icon fetch failed'); return r.blob(); })
                .then((blob) => {
                    const url = URL.createObjectURL(blob);
                    iconObjectUrls.set(item.iconKey, url);
                    img.src = url;
                })
                .catch(() => img.onerror());
        }
    } else if (item.iconUrl) {
        img.src = item.iconUrl;
    } else if (item.url) {
        img.src = `https://www.google.com/s2/favicons?domain=${item.url}&sz=64`;
    } else {
        img.onerror();
    }

    return iconContainer;
}

function isLockedPlaceholder(item) {
    // Only the corp view ever contains these: the server redacts a locked
    // node down to {id, x, y, locked, kind} with no content at all.
    return item.locked === true && role !== 'master';
}

function loadBookmarks() {
    const bookmarks = getCurrentBookmarks();
    const container = document.getElementById('bookmarksContainer');

    while (container.children.length > 1) {
        container.removeChild(container.lastChild);
    }

    bookmarkNumberMap = {};

    if (currentFolderPath.length > 0) {
        const folderData = getFolderData();
        if (folderData) {
            bookmarkNumberMap[1] = { key: null, item: folderData, isBack: true };
            createBookmarkElement(folderData, null, container, true, 1);
        }
    }

    const sortedEntries = Object.entries(bookmarks).sort(([, a], [, b]) => {
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
    });

    document.getElementById('addBookmarkBtn').parentElement.style.display = lockMode ? 'none' : '';

    const startNumber = currentFolderPath.length > 0 ? 2 : 1;
    let number = startNumber;
    sortedEntries.forEach(([key, item]) => {
        if (lockMode || isLockedPlaceholder(item)) {
            createBookmarkElement(item, key, container, false, null);
        } else {
            bookmarkNumberMap[number] = { key, item };
            createBookmarkElement(item, key, container, false, number);
            number += 1;
        }
    });
}

function createBookmarkElement(item, key, container, isFolderBack = false, number = null) {
    const bookmarkEl = document.createElement('div');
    bookmarkEl.className = 'bookmark';
    bookmarkEl.style.gridColumn = Math.floor(item.x / GRID_SIZE) + 1;
    bookmarkEl.style.gridRow = Math.floor(item.y / GRID_SIZE) + 1;

    const bookmarkBox = document.createElement('div');
    bookmarkBox.className = 'bookmark-box';

    if (isLockedPlaceholder(item)) {
        // A cell someone else owns: visible so nothing lands on top of it,
        // but inert - no name, no URL, no way in.
        bookmarkBox.className += ' locked-placeholder';
        if (item.kind === 'folder') bookmarkBox.className += ' folder-icon';
        bookmarkBox.textContent = '🔒';
        bookmarkBox.dataset.isFixed = 'true';
        bookmarkEl.appendChild(bookmarkBox);
        container.appendChild(bookmarkEl);
        return;
    }

    // Lock mode (master only): render this level exactly as corp would see
    // it - locked items as mute placeholders, unlocked ones as themselves -
    // and every click is a lock toggle. Nothing opens, nothing drags; to
    // edit locks inside a folder, enter it first and switch the mode there.
    if (lockMode && !isFolderBack && key !== null) {
        bookmarkEl.className += ' lock-mode-target';
        if (item.locked) {
            bookmarkBox.className += ' locked-placeholder';
            if (item.bookmarks) bookmarkBox.className += ' folder-icon';
            bookmarkBox.textContent = '🔒';
        } else {
            if (item.bookmarks) {
                bookmarkBox.className += ' folder-icon';
            } else {
                bookmarkBox.appendChild(createIconElement(item));
            }
            const nameEl = document.createElement('div');
            nameEl.className = 'bookmark-name';
            nameEl.textContent = item.name;
            bookmarkEl.appendChild(nameEl);
        }
        bookmarkBox.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleLock(key);
        });
        bookmarkEl.insertBefore(bookmarkBox, bookmarkEl.firstChild);
        container.appendChild(bookmarkEl);
        return;
    }

    if (item.bookmarks || isFolderBack) {
        bookmarkBox.className += ' folder-icon';
        bookmarkBox.dataset.isFolder = 'true';
        if (isFolderBack) {
            bookmarkBox.dataset.isBackFolder = 'true';
            bookmarkBox.dataset.isFixed = 'true';
        }
    } else {
        const iconEl = createIconElement(item);
        bookmarkBox.appendChild(iconEl);
    }

    if (number !== null && !isFolderBack) {
        const numberBadge = document.createElement('div');
        numberBadge.className = 'bookmark-number';
        numberBadge.textContent = number;
        bookmarkBox.appendChild(numberBadge);
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'bookmark-name';
    nameEl.textContent = item.name;

    bookmarkEl.appendChild(bookmarkBox);
    bookmarkEl.appendChild(nameEl);

    if (!isFolderBack) {
        bookmarkBox.addEventListener('mousedown', startInteraction);
        bookmarkBox.addEventListener('click', handleClick);
        if (key !== null) {
            bookmarkBox.dataset.key = key;
        }
        if (item.url) {
            bookmarkBox.dataset.url = item.url;
        }
    } else {
        bookmarkBox.addEventListener('click', (e) => {
            if (!isDragging && !dragThreshold) {
                exitFolder();
            }
            e.preventDefault();
            e.stopPropagation();
        });
    }

    container.appendChild(bookmarkEl);
}

function getFolderData() {
    const allBookmarks = JSON.parse(localStorage.getItem('customBookmarks') || '{}');

    if (currentFolderPath.length === 0) return null;

    let current = allBookmarks;
    for (let i = 0; i < currentFolderPath.length - 1; i++) {
        current = current[currentFolderPath[i]].bookmarks;
    }

    return current[currentFolderPath[currentFolderPath.length - 1]];
}

function getCurrentBookmarks() {
    const allBookmarks = JSON.parse(localStorage.getItem('customBookmarks') || '{}');

    if (currentFolderPath.length === 0) {
        return allBookmarks;
    }

    let current = allBookmarks;
    for (const folderKey of currentFolderPath) {
        if (current[folderKey] && current[folderKey].bookmarks) {
            current = current[folderKey].bookmarks;
        } else {
            currentFolderPath = [];
            return allBookmarks;
        }
    }

    return current;
}

function dragBookmark(e) {
    if (draggedElement) {
        currentX = e.clientX;
        currentY = e.clientY;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
            dragThreshold = true;
            draggedElement.style.opacity = '0.5';
            draggedElement.style.pointerEvents = 'none';

            const rect = document.getElementById('bookmarksContainer').getBoundingClientRect();
            const x = snapToGrid(e.clientX - rect.left - 50);
            const y = snapToGrid(e.clientY - rect.top - 50);

            draggedElement.style.gridColumn = Math.floor(x / GRID_SIZE) + 1;
            draggedElement.style.gridRow = Math.floor(y / GRID_SIZE) + 1;

            const elementBelow = document.elementFromPoint(e.clientX, e.clientY);
            const folderBox = elementBelow?.closest('.bookmark-box[data-is-folder="true"]:not([data-is-back-folder="true"])');

            if (folderBox) {
                folderBox.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
            } else {
                document.querySelectorAll('.bookmark-box[data-is-folder="true"]:not([data-is-back-folder="true"])').forEach(box => {
                    box.style.backgroundColor = '';
                });
            }
        }
    }
}

function stopDrag() {
    let operationCompleted = false;

    if (draggedElement && dragThreshold) {
        const allBookmarks = JSON.parse(localStorage.getItem('customBookmarks') || '{}');
        const draggedKey = draggedElement.querySelector('.bookmark-box').dataset.key;

        const elementBelow = document.elementFromPoint(currentX, currentY);
        const backFolderBox = elementBelow?.closest('.bookmark-box[data-is-back-folder="true"]');
        const folderBox = elementBelow?.closest('.bookmark-box[data-is-folder="true"]:not([data-is-back-folder="true"])');

        draggedElement.style.opacity = '1';
        draggedElement.style.pointerEvents = 'auto';

        if (backFolderBox && draggedKey && currentFolderPath.length > 0) {
            operationCompleted = true;
            const freshAllBookmarks = JSON.parse(localStorage.getItem('customBookmarks') || '{}');

            let currentBookmarks = freshAllBookmarks;
            for (const folderKey of currentFolderPath) {
                currentBookmarks = currentBookmarks[folderKey].bookmarks;
            }

            const itemToMove = currentBookmarks[draggedKey];

            if (itemToMove && !itemToMove.hasOwnProperty('bookmarks')) {
                delete currentBookmarks[draggedKey];

                let parentBookmarks = freshAllBookmarks;
                for (let i = 0; i < currentFolderPath.length - 1; i++) {
                    parentBookmarks = parentBookmarks[currentFolderPath[i]].bookmarks;
                }

                let foundPosition = false;
                for (let row = 1; row < 20; row++) {
                    for (let col = 1; col < 20; col++) {
                        const testX = col * GRID_SIZE;
                        const testY = row * GRID_SIZE;
                        const testKey = `${testX}_${testY}`;
                        if (!parentBookmarks[testKey]) {
                            itemToMove.x = testX;
                            itemToMove.y = testY;
                            parentBookmarks[testKey] = itemToMove;
                            foundPosition = true;
                            break;
                        }
                    }
                    if (foundPosition) break;
                }

                if (foundPosition) {
                    localStorage.setItem('customBookmarks', JSON.stringify(freshAllBookmarks));
                    currentFolderPath.pop();
                    loadBookmarks();
                    scheduleSync();
                } else {
                    loadBookmarks();
                }
            } else {
                loadBookmarks();
            }
        } else if (folderBox && draggedKey) {
            operationCompleted = true;
            const targetFolderKey = folderBox.dataset.key;

            if (targetFolderKey && targetFolderKey !== draggedKey) {
                const currentBookmarks = getCurrentBookmarks();
                const itemToMove = currentBookmarks[draggedKey];
                const targetFolder = currentBookmarks[targetFolderKey];

                const isItemFolder = itemToMove && itemToMove.hasOwnProperty('bookmarks');
                const isTargetFolder = targetFolder && targetFolder.hasOwnProperty('bookmarks');

                if (itemToMove && !isItemFolder && isTargetFolder) {
                    delete currentBookmarks[draggedKey];

                    let foundPosition = false;
                    for (let row = 2; row < 20; row++) {
                        for (let col = 1; col < 20; col++) {
                            const testX = col * GRID_SIZE;
                            const testY = row * GRID_SIZE;
                            const testKey = `${testX}_${testY}`;
                            if (!targetFolder.bookmarks[testKey]) {
                                itemToMove.x = testX;
                                itemToMove.y = testY;
                                targetFolder.bookmarks[testKey] = itemToMove;
                                foundPosition = true;
                                break;
                            }
                        }
                        if (foundPosition) break;
                    }

                    if (foundPosition) {
                        updateMainBookmarks(allBookmarks, currentBookmarks);
                        localStorage.setItem('customBookmarks', JSON.stringify(allBookmarks));
                        loadBookmarks();
                        scheduleSync();
                    } else {
                        currentBookmarks[draggedKey] = itemToMove;
                        loadBookmarks();
                    }
                } else {
                    moveToFreeCellOrRevert(allBookmarks, draggedKey);
                }
            } else {
                moveToFreeCellOrRevert(allBookmarks, draggedKey);
            }
        } else if (draggedKey) {
            operationCompleted = true;
            moveToFreeCellOrRevert(allBookmarks, draggedKey);
        }

        document.querySelectorAll('.bookmark-box[data-is-folder="true"]:not([data-is-back-folder="true"])').forEach(box => {
            box.style.backgroundColor = '';
        });
    }

    document.removeEventListener('mousemove', dragBookmark);
    document.removeEventListener('mouseup', stopDrag);
    draggedElement = null;

    setTimeout(() => {
        dragThreshold = false;
        isDragging = false;
    }, operationCompleted ? 200 : 100);
}

// Shared tail of the drag paths: commit the dragged element's new grid cell
// if free, else revert. (The three near-identical copies in the original
// collapsed into this.)
function moveToFreeCellOrRevert(allBookmarks, draggedKey) {
    const currentBookmarks = getCurrentBookmarks();
    const item = currentBookmarks[draggedKey];

    if (!item) {
        loadBookmarks();
        return;
    }

    const column = parseInt(draggedElement.style.gridColumn) - 1;
    const row = parseInt(draggedElement.style.gridRow) - 1;
    const newX = column * GRID_SIZE;
    const newY = row * GRID_SIZE;
    const newKey = `${newX}_${newY}`;

    if (currentBookmarks[newKey] && newKey !== draggedKey) {
        loadBookmarks();
    } else {
        delete currentBookmarks[draggedKey];
        item.x = newX;
        item.y = newY;
        currentBookmarks[newKey] = item;

        updateMainBookmarks(allBookmarks, currentBookmarks);
        localStorage.setItem('customBookmarks', JSON.stringify(allBookmarks));
        loadBookmarks();
        scheduleSync();
    }
}

function handleClick(e) {
    if (isDragging || dragThreshold) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    const isFolder = e.currentTarget.dataset.isFolder === 'true';
    const isBackFolder = e.currentTarget.dataset.isBackFolder === 'true';
    const key = e.currentTarget.dataset.key;

    if (isFolder) {
        if (isBackFolder) {
            exitFolder();
        } else if (e.metaKey && e.shiftKey) {
            if (key) {
                openEditModal(key);
            }
        } else {
            if (key) {
                enterFolder(key);
            }
        }
    } else {
        const url = e.currentTarget.dataset.url;
        if (url && !e.metaKey) {
            window.open(url, '_self');
        }
    }
}

function enterFolder(folderKey) {
    currentFolderPath.push(folderKey);
    loadBookmarks();
    updateBackIndicator();
}

function exitFolder() {
    if (currentFolderPath.length > 0) {
        currentFolderPath.pop();
        loadBookmarks();
        updateBackIndicator();
    }
}

function updateBackIndicator() {
    const indicator = document.getElementById('backIndicator');
    if (currentFolderPath.length > 0) {
        indicator.classList.add('visible');
    } else {
        indicator.classList.remove('visible');
    }
}

function startInteraction(e) {
    if (e.target.classList.contains('bookmark-add')) return;
    if (e.currentTarget.dataset.isFixed === 'true') return;

    startX = e.clientX;
    startY = e.clientY;
    dragThreshold = false;
    isDragging = false;

    if (e.metaKey && e.shiftKey) {
        openEditModal(e.currentTarget.dataset.key);
    } else if (e.metaKey) {
        isDragging = true;
        draggedElement = e.currentTarget.parentElement;
        document.addEventListener('mousemove', dragBookmark);
        document.addEventListener('mouseup', stopDrag);
    }
}

function toggleLockMode() {
    if (role !== 'master') return;
    lockMode = !lockMode;
    document.getElementById('lockModeBtn').classList.toggle('active', lockMode);
    document.body.classList.toggle('lock-mode', lockMode);
    loadBookmarks();
}

function toggleLock(key) {
    const allBookmarks = JSON.parse(localStorage.getItem('customBookmarks') || '{}');
    const currentBookmarks = currentFolderPath.length === 0
        ? allBookmarks
        : (() => {
            let cur = allBookmarks;
            for (const k of currentFolderPath) cur = cur[k].bookmarks;
            return cur;
        })();
    const item = currentBookmarks[key];
    if (!item) return;
    item.locked = item.locked !== true;
    localStorage.setItem('customBookmarks', JSON.stringify(allBookmarks));
    loadBookmarks();
    scheduleSync();
}

// ---- add / edit / delete ----

function openEditModal(key) {
    const currentBookmarks = getCurrentBookmarks();
    const item = currentBookmarks[key];
    if (!item || isLockedPlaceholder(item)) return;

    document.querySelector('.type-selector').style.display = 'none';
    document.getElementById('bookmarkIconFile').value = '';
    switchIconMode(item.iconKey && !item.iconUrl ? 'file' : 'url');
    showStoredIconStatus(item.iconKey || null);

    if (item.bookmarks) {
        document.getElementById('modalTitle').textContent = 'Edit Folder';
        switchType('folder');
        document.getElementById('bookmarkName').value = item.name;
        document.getElementById('bookmarkURL').value = '';
        document.getElementById('bookmarkIcon').value = '';
    } else {
        document.getElementById('modalTitle').textContent = 'Edit Bookmark';
        switchType('bookmark');
        document.getElementById('bookmarkName').value = item.name;
        document.getElementById('bookmarkURL').value = item.url;
        document.getElementById('bookmarkIcon').value = item.iconUrl || '';
    }

    document.getElementById('deleteBtn').style.display = 'block';
    editKey = key;
    document.getElementById('bookmarkModal').style.display = 'flex';
}

async function uploadIconFile(file) {
    const buffer = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const response = await fetch(`${API_BASE}/newtab/icons`, {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ dataBase64: btoa(binary), contentType: file.type }),
    });
    if (!response.ok) throw new Error('icon upload failed');
    const { key } = await response.json();
    return key;
}

async function saveBookmark() {
    const name = document.getElementById('bookmarkName').value.trim();
    const url = document.getElementById('bookmarkURL').value.trim();
    const iconFileChosen = document.getElementById('iconFileMode').classList.contains('active');
    const iconUrl = iconFileChosen ? '' : document.getElementById('bookmarkIcon').value.trim();
    const iconFile = iconFileChosen ? (document.getElementById('bookmarkIconFile').files[0] || null) : null;
    const isFolder = document.getElementById('folderType').classList.contains('active');

    if (!name || (!isFolder && !url)) return;

    let iconKey = null;
    if (iconFile && !isFolder) {
        try {
            iconKey = await uploadIconFile(iconFile);
        } catch (err) {
            console.error(err);
            alert('Icon upload failed - saving without it.');
        }
    }

    const allBookmarks = JSON.parse(localStorage.getItem('customBookmarks') || '{}');
    const currentBookmarks = getCurrentBookmarks();

    if (isFolder) {
        if (editKey !== null) {
            currentBookmarks[editKey].name = name;
        } else {
            const newFolder = { name, bookmarks: {}, x: GRID_SIZE, y: GRID_SIZE };
            if (!insertAtFreePosition(currentBookmarks, newFolder)) {
                alert('No space available!');
                return;
            }
        }
    } else {
        const formattedUrl = url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;

        if (editKey !== null) {
            const item = currentBookmarks[editKey];
            item.name = name;
            item.url = formattedUrl;
            if (iconKey) {
                item.iconKey = iconKey;
                item.iconUrl = '';
            } else if (!iconFileChosen) {
                item.iconUrl = iconUrl;
                if (iconUrl) delete item.iconKey;
            }
        } else {
            const newBookmark = { name, url: formattedUrl, iconUrl, x: GRID_SIZE, y: GRID_SIZE };
            if (iconKey) newBookmark.iconKey = iconKey;
            if (!insertAtFreePosition(currentBookmarks, newBookmark)) {
                alert('No space available!');
                return;
            }
        }
    }

    updateMainBookmarks(allBookmarks, currentBookmarks);
    localStorage.setItem('customBookmarks', JSON.stringify(allBookmarks));
    loadBookmarks();
    closeBookmarkModal();
    scheduleSync();
}

function insertAtFreePosition(currentBookmarks, newItem) {
    const backFolderPosition = currentFolderPath.length > 0 ? getFolderData() : null;

    for (let row = 1; row < 20; row++) {
        for (let col = 1; col < 20; col++) {
            const testX = col * GRID_SIZE;
            const testY = row * GRID_SIZE;
            const testKey = `${testX}_${testY}`;

            const isBackFolderPosition = backFolderPosition &&
                backFolderPosition.x === testX &&
                backFolderPosition.y === testY;

            if (!currentBookmarks[testKey] && !isBackFolderPosition) {
                newItem.x = testX;
                newItem.y = testY;
                currentBookmarks[testKey] = newItem;
                return true;
            }
        }
    }
    return false;
}

function updateMainBookmarks(allBookmarks, updatedCurrent) {
    if (currentFolderPath.length === 0) {
        Object.keys(allBookmarks).forEach(key => delete allBookmarks[key]);
        Object.assign(allBookmarks, updatedCurrent);
    } else {
        let current = allBookmarks;
        for (let i = 0; i < currentFolderPath.length - 1; i++) {
            current = current[currentFolderPath[i]].bookmarks;
        }
        const parentKey = currentFolderPath[currentFolderPath.length - 1];
        current[parentKey].bookmarks = updatedCurrent;
    }
}

function deleteBookmark() {
    if (editKey !== null) {
        const allBookmarks = JSON.parse(localStorage.getItem('customBookmarks') || '{}');
        const currentBookmarks = getCurrentBookmarks();
        delete currentBookmarks[editKey];

        updateMainBookmarks(allBookmarks, currentBookmarks);
        localStorage.setItem('customBookmarks', JSON.stringify(allBookmarks));
        loadBookmarks();
        closeBookmarkModal();
        scheduleSync();
    }
}

function openBookmarkModal() {
    editKey = null;
    document.getElementById('modalTitle').textContent = 'Add Bookmark';
    document.getElementById('bookmarkName').value = '';
    document.getElementById('bookmarkURL').value = '';
    document.getElementById('bookmarkIcon').value = '';
    document.getElementById('bookmarkIconFile').value = '';
    switchIconMode('url');
    showStoredIconStatus(null);
    document.getElementById('deleteBtn').style.display = 'none';

    document.querySelector('.type-selector').style.display = 'flex';

    switchType('bookmark');
    document.getElementById('bookmarkModal').style.display = 'flex';
}

function closeBookmarkModal() {
    document.getElementById('bookmarkModal').style.display = 'none';
    editKey = null;
}

function switchType(type) {
    const bookmarkType = document.getElementById('bookmarkType');
    const folderType = document.getElementById('folderType');
    const urlInput = document.getElementById('bookmarkURL');

    if (type === 'bookmark') {
        bookmarkType.classList.add('active');
        folderType.classList.remove('active');
        urlInput.style.display = 'block';
        document.getElementById('iconSelector').style.display = 'flex';
        switchIconMode(document.getElementById('iconFileMode').classList.contains('active') ? 'file' : 'url');
        urlInput.placeholder = 'URL';
        document.getElementById('bookmarkName').placeholder = 'Site Name';
    } else {
        folderType.classList.add('active');
        bookmarkType.classList.remove('active');
        urlInput.style.display = 'none';
        document.getElementById('iconSelector').style.display = 'none';
        document.getElementById('bookmarkIcon').style.display = 'none';
        document.getElementById('iconFileRow').style.display = 'none';
        document.getElementById('bookmarkName').placeholder = 'Folder Name';
    }
}

// The file input cannot be prefilled, so an already-uploaded icon would
// otherwise look like "no file". This shows a small thumbnail + note when
// the item carries a stored icon; picking a new file replaces it.
function showStoredIconStatus(iconKey) {
    const status = document.getElementById('iconFileStatus');
    const preview = document.getElementById('iconFilePreview');
    if (!iconKey) {
        status.style.display = 'none';
        preview.removeAttribute('src');
        return;
    }
    status.style.display = 'inline-flex';
    const cached = iconObjectUrls.get(iconKey);
    if (cached) {
        preview.src = cached;
    } else {
        fetch(`${API_BASE}/newtab/icons/${iconKey.replace(/^icons\//, '')}`, { headers: apiHeaders() })
            .then((r) => { if (!r.ok) throw new Error('icon fetch failed'); return r.blob(); })
            .then((blob) => {
                const url = URL.createObjectURL(blob);
                iconObjectUrls.set(iconKey, url);
                preview.src = url;
            })
            .catch(() => {});
    }
}

// One icon source at a time: URL or uploaded file, never both.
function switchIconMode(mode) {
    const urlBtn = document.getElementById('iconUrlMode');
    const fileBtn = document.getElementById('iconFileMode');
    const urlInput = document.getElementById('bookmarkIcon');
    const fileRow = document.getElementById('iconFileRow');
    const isUrl = mode === 'url';
    urlBtn.classList.toggle('active', isUrl);
    fileBtn.classList.toggle('active', !isUrl);
    urlInput.style.display = isUrl ? 'block' : 'none';
    fileRow.style.display = isUrl ? 'none' : 'flex';
}

// ---- number navigation ----

function updateNumberDisplay() {
    const display = document.getElementById('numberInputDisplay');

    if (typedNumber) {
        display.textContent = typedNumber;
        display.classList.add('visible');

        if (numberInputTimeout) {
            clearTimeout(numberInputTimeout);
        }

        numberInputTimeout = setTimeout(() => {
            clearNumberInput();
        }, 2000);
    } else {
        display.classList.remove('visible');
    }
}

function clearNumberInput() {
    typedNumber = '';
    const display = document.getElementById('numberInputDisplay');
    display.classList.remove('visible');
    if (numberInputTimeout) {
        clearTimeout(numberInputTimeout);
        numberInputTimeout = null;
    }
}

function navigateToNumber(num) {
    const entry = bookmarkNumberMap[num];
    if (!entry) return;

    const { key, item, isBack } = entry;

    if (isBack) {
        exitFolder();
    } else if (item.bookmarks) {
        enterFolder(key);
    } else if (item.url) {
        window.open(item.url, '_self');
    }
}

// ---- air quality (master only; served through the backend) ----

async function updateAirQuality() {
    try {
        const response = await fetch(`${API_BASE}/newtab/air`, { headers: apiHeaders() });
        if (!response.ok) throw new Error('Failed to fetch air quality data');

        const data = await response.json();

        let emoji = '';
        const pm25 = data.pm25 || 0;
        const status = "Jakość powietrza";
        if (pm25 <= 13) {
            emoji = '😊';
        } else if (pm25 <= 35) {
            emoji = '🙂';
        } else if (pm25 <= 55) {
            emoji = '😐';
        } else if (pm25 <= 75) {
            emoji = '😷';
        } else if (pm25 <= 110) {
            emoji = '🤢';
        } else {
            emoji = '⚠️';
        }

        document.getElementById('pm25').textContent = `${data.pm25 || '--'} µg/m³`;
        document.getElementById('pm10').textContent = `${data.pm10 || '--'} µg/m³`;
        document.getElementById('airStatus').textContent = `${status} ${emoji}`;
    } catch (error) {
        console.error('Error fetching air quality data:', error);
        document.getElementById('pm25').textContent = '--';
        document.getElementById('pm10').textContent = '--';
        document.getElementById('airStatus').textContent = '--';
    }
}

// ---- search ----

function getAllBookmarksFlat() {
    const rootBookmarks = JSON.parse(localStorage.getItem('customBookmarks') || '{}');
    const flat = [];

    function walk(bookmarksObj, keyPath, namePath) {
        Object.entries(bookmarksObj).forEach(([key, item]) => {
            if (isLockedPlaceholder(item)) return; // nothing to show or open
            const isFolder = !!item.bookmarks;
            flat.push({
                name: item.name,
                url: item.url,
                iconUrl: item.iconUrl,
                iconKey: item.iconKey,
                isFolder,
                keyPath: [...keyPath, key],
                folderPath: namePath.join(' / ')
            });
            if (isFolder) {
                walk(item.bookmarks, [...keyPath, key], [...namePath, item.name]);
            }
        });
    }

    walk(rootBookmarks, [], []);
    return flat;
}

function filterBookmarks(query) {
    const q = query.trim().toLowerCase();
    const all = getAllBookmarksFlat();
    if (!q) return all;

    return all.filter(entry => {
        const nameMatch = entry.name && entry.name.toLowerCase().includes(q);
        const urlMatch = entry.url && entry.url.toLowerCase().includes(q);
        return nameMatch || urlMatch;
    });
}

function renderSearchResults(query) {
    const container = document.getElementById('searchResults');
    container.innerHTML = '';

    const matches = filterBookmarks(query || '');

    if (matches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'search-result-empty';
        empty.textContent = 'No matches';
        container.appendChild(empty);
        return;
    }

    matches.forEach(entry => {
        const bookmarkEl = document.createElement('div');
        bookmarkEl.className = 'bookmark';

        const bookmarkBox = document.createElement('div');
        bookmarkBox.className = 'bookmark-box';

        if (entry.isFolder) {
            bookmarkBox.className += ' folder-icon';
        } else {
            const iconEl = createIconElement(entry);
            bookmarkBox.appendChild(iconEl);
        }

        const nameEl = document.createElement('div');
        nameEl.className = 'bookmark-name';
        nameEl.textContent = entry.name;

        bookmarkEl.appendChild(bookmarkBox);
        bookmarkEl.appendChild(nameEl);

        if (entry.folderPath) {
            const subtitleEl = document.createElement('div');
            subtitleEl.className = 'search-result-subtitle';
            subtitleEl.textContent = entry.folderPath;
            bookmarkEl.appendChild(subtitleEl);
        }

        bookmarkBox.addEventListener('click', () => selectSearchResult(entry));

        container.appendChild(bookmarkEl);
    });
}

function selectSearchResult(entry) {
    if (entry.isFolder) {
        currentFolderPath = [...entry.keyPath];
        loadBookmarks();
        updateBackIndicator();
        closeSearchOverlay();
    } else if (entry.url) {
        closeSearchOverlay();
        window.open(entry.url, '_self');
    }
}

function selectFirstSearchResult() {
    const firstBox = document.getElementById('searchResults').querySelector('.bookmark-box');
    if (firstBox) {
        firstBox.click();
    }
}

function openSearchOverlay() {
    const input = document.getElementById('searchInput');
    input.value = '';
    document.body.classList.add('search-active');
    document.getElementById('searchOverlay').style.display = 'flex';
    renderSearchResults('');
    input.focus();
}

function closeSearchOverlay() {
    const overlay = document.getElementById('searchOverlay');
    if (overlay.style.display === 'flex') {
        overlay.style.display = 'none';
    }
    document.body.classList.remove('search-active');
    document.getElementById('searchInput').value = '';
    document.getElementById('searchResults').innerHTML = '';
}

// ---- wallpapers ----
//
// The pool lives in S3 under wallpapers/ and is served by the backend; the
// only local state is the chosen key in localStorage, so a fresh machine
// shows the bundled content/main.png until a pick is made. Bytes come back
// with a week of private cache, so the swap-in after first load is the cold
// case, not the every-tab case.

const WALLPAPER_LS_KEY = 'wallpaperKey';
const wallpaperObjectUrls = new Map(); // key -> objectURL cache for this page

async function fetchWallpaperUrl(key) {
    const cached = wallpaperObjectUrls.get(key);
    if (cached) return cached;
    const name = key.replace(/^wallpapers\//, '');
    const response = await fetch(`${API_BASE}/newtab/wallpapers/${encodeURIComponent(name)}`, { headers: apiHeaders() });
    if (!response.ok) throw new Error(`wallpaper fetch failed: ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    wallpaperObjectUrls.set(key, url);
    return url;
}

async function applyWallpaper(key) {
    if (!key) {
        document.body.style.backgroundImage = ''; // back to the bundled CSS default
        return;
    }
    try {
        const url = await fetchWallpaperUrl(key);
        document.body.style.backgroundImage = `url("${url}")`;
    } catch (err) {
        console.error('Wallpaper apply failed - keeping current background:', err);
    }
}

function applyStoredWallpaper() {
    const key = localStorage.getItem(WALLPAPER_LS_KEY);
    if (key && apiToken) applyWallpaper(key);
}

function selectWallpaper(key) {
    if (key) localStorage.setItem(WALLPAPER_LS_KEY, key);
    else localStorage.removeItem(WALLPAPER_LS_KEY);
    applyWallpaper(key);
    document.querySelectorAll('.wallpaper-tile').forEach((el) => {
        el.classList.toggle('selected', (el.dataset.key || '') === (key || ''));
    });
}

async function openWallpaperModal() {
    const modal = document.getElementById('wallpaperModal');
    const grid = document.getElementById('wallpaperGrid');
    grid.innerHTML = '<div class="history-loading">Loading…</div>';
    document.getElementById('wallpaperUploadRow').style.display = role === 'master' ? '' : 'none';
    document.getElementById('wallpaperUploadStatus').textContent = '';
    modal.style.display = 'flex';

    try {
        const response = await fetch(`${API_BASE}/newtab/wallpapers`, { headers: apiHeaders() });
        if (!response.ok) throw new Error(`list failed: ${response.status}`);
        const { wallpapers } = await response.json();
        renderWallpaperGrid(wallpapers || []);
    } catch (error) {
        console.error('Error listing wallpapers:', error);
        grid.innerHTML = '<div class="history-error">Failed to load wallpapers.</div>';
    }
}

function closeWallpaperModal() {
    const modal = document.getElementById('wallpaperModal');
    if (modal.style.display === 'flex') {
        modal.style.display = 'none';
    }
}

function wallpaperLabel(key) {
    return key
        .replace(/^wallpapers\//, '')
        .replace(/\.(png|jpe?g|webp)$/i, '')
        .replace(/-[0-9a-f]{8}$/, ''); // drop the upload collision suffix
}

function wallpaperTile({ key, label, src, load }) {
    const tile = document.createElement('div');
    tile.className = 'wallpaper-tile';
    tile.dataset.key = key;
    if ((localStorage.getItem(WALLPAPER_LS_KEY) || '') === key) tile.classList.add('selected');

    const img = document.createElement('img');
    img.alt = label;
    if (src) {
        img.src = src;
    } else if (load) {
        load().then((url) => { img.src = url; }).catch(() => tile.classList.add('broken'));
    }

    const name = document.createElement('span');
    name.className = 'wallpaper-tile-name';
    name.textContent = label;

    tile.appendChild(img);
    tile.appendChild(name);
    tile.addEventListener('click', () => selectWallpaper(key));
    return tile;
}

function renderWallpaperGrid(wallpapers) {
    const grid = document.getElementById('wallpaperGrid');
    grid.innerHTML = '';

    // Bundled default first - always available, even offline.
    grid.appendChild(wallpaperTile({ key: '', label: 'Default', src: 'content/main.png' }));

    wallpapers.forEach((w) => {
        grid.appendChild(wallpaperTile({
            key: w.key,
            label: wallpaperLabel(w.key),
            load: () => fetchWallpaperUrl(w.key),
        }));
    });
}

async function uploadWallpaperFile(file) {
    const status = document.getElementById('wallpaperUploadStatus');
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        status.textContent = 'png / jpeg / webp only';
        return;
    }
    status.textContent = 'Uploading…';
    try {
        const response = await fetch(`${API_BASE}/newtab/wallpapers?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: apiHeaders({ 'Content-Type': file.type }),
            body: file,
        });
        if (!response.ok) throw new Error(`upload failed: ${response.status}`);
        const { key } = await response.json();
        status.textContent = 'Uploaded ✓';
        selectWallpaper(key);
        const listResponse = await fetch(`${API_BASE}/newtab/wallpapers`, { headers: apiHeaders() });
        if (listResponse.ok) renderWallpaperGrid((await listResponse.json()).wallpapers || []);
    } catch (error) {
        console.error('Wallpaper upload failed:', error);
        status.textContent = 'Upload failed';
    }
}

// ---- version history (master only) ----

async function openHistoryModal() {
    const modal = document.getElementById('historyModal');
    const list = document.getElementById('historyList');
    list.innerHTML = '<div class="history-loading">Loading…</div>';
    modal.style.display = 'flex';

    try {
        const response = await fetch(`${API_BASE}/newtab/history`, { headers: apiHeaders() });
        if (!response.ok) throw new Error('Failed to fetch history');
        const versions = await response.json();
        renderHistoryList(versions);
    } catch (error) {
        console.error('Error fetching history:', error);
        list.innerHTML = '<div class="history-error">Failed to load history.</div>';
    }
}

function closeHistoryModal() {
    const modal = document.getElementById('historyModal');
    if (modal.style.display === 'flex') {
        modal.style.display = 'none';
    }
}

function formatHistorySize(bytes) {
    if (typeof bytes !== 'number') return '';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatRelativeTime(ts) {
    const then = new Date(ts).getTime();
    if (!Number.isFinite(then)) return 'unknown';
    const diff = Date.now() - then;
    const sec = Math.round(diff / 1000);
    if (sec < 45) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hours = Math.round(min / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;
    const months = Math.round(days / 30);
    if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
    const years = Math.round(months / 12);
    return years === 1 ? '1 year ago' : `${years} years ago`;
}

function renderHistoryList(versions) {
    const list = document.getElementById('historyList');
    list.innerHTML = '';

    if (!versions || versions.length === 0) {
        list.innerHTML = '<div class="history-empty">No versions yet. Click Sync first.</div>';
        return;
    }

    versions.forEach((version) => {
        const row = document.createElement('div');
        row.className = 'history-row' + (version.isLatest ? ' is-current' : '');

        const labelEl = document.createElement('span');
        labelEl.className = 'history-label';
        labelEl.textContent = `v${version.number}`;

        const tagsEl = document.createElement('span');
        tagsEl.className = 'history-tags';
        if (version.isLatest) tagsEl.appendChild(historyTag('current', 'tag-current'));
        if (version.restoredFrom) tagsEl.appendChild(historyTag(`copy of v${version.restoredFrom}`, 'tag-copy'));
        if (version.author === 'corp') tagsEl.appendChild(historyTag('corp', 'tag-corp'));

        const dateEl = document.createElement('span');
        dateEl.className = 'history-date';
        dateEl.textContent = version.timestamp ? formatRelativeTime(version.timestamp) : 'unknown';
        if (version.timestamp) dateEl.title = new Date(version.timestamp).toLocaleString();

        const metaEl = document.createElement('span');
        metaEl.className = 'history-meta';
        metaEl.textContent = formatHistorySize(version.size);

        row.appendChild(labelEl);
        row.appendChild(tagsEl);
        row.appendChild(dateEl);
        row.appendChild(metaEl);
        row.addEventListener('click', () => restoreVersion(version.number));

        list.appendChild(row);
    });
}

function historyTag(text, className) {
    const el = document.createElement('span');
    el.className = `history-tag ${className}`;
    el.textContent = text;
    return el;
}

async function restoreVersion(number) {
    const confirmed = confirm(`Restore v${number}? Current state will be replaced, but nothing is ever deleted from history.`);
    if (!confirmed) return;

    try {
        const response = await fetch(`${API_BASE}/newtab/history/${number}`, { headers: apiHeaders() });
        if (!response.ok) throw new Error('Failed to fetch version');
        const content = await response.json();

        localStorage.setItem('customBookmarks', JSON.stringify(content));
        currentFolderPath = [];
        loadBookmarks();
        updateBackIndicator();
        closeHistoryModal();

        try {
            await syncToServer({ showFeedback: true, restoredFrom: number });
        } catch (syncError) {
            console.error('Restored locally but failed to re-sync as new head:', syncError);
        }
    } catch (error) {
        console.error('Error restoring version:', error);
        alert('Failed to restore that version.');
    }
}
