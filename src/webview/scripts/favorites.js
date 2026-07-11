// Favorites関連処理 - Virtual Folders Only (完全版)

let editingFavorite = null;
let allFavoritesData = null;
let virtualFolders = [];
let selectedVirtualFolderId = null;
let draggedFile = null;
let draggedFromFolderId = null;   // ファイル用: 元のフォルダID
let draggedFolder = null;
let draggedFolderParentId = null; // フォルダ用: ドラッグ元の親ID
let currentDragMode = null; // 'before' | 'after' | 'into'
let dragOverTarget = null; // 現在ドラッグオーバーしている要素
let insertPosition = null; // 'before' | 'after'
// flickering防止用: 前回のプレースホルダー状態
let lastPlaceholderTarget = null;
let lastPlaceholderPosition = null;
let editingFolderId = null;
let creatingSubfolderForId = null;
let currentColorPickerFolderId = null; // カラーピッカーのトグル用
let selectedItemPath = null;  // F2キー用
let selectedFolderId = null;   // F2キー用
let favoritesDefaultExpandState = 'collapsed'; // 初期開閉状態

// 🔧 FIX: トグル機能のための変数
let currentAddFilePopupFolderId = null;

// SVGアイコン定義
const FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 3H6.5L8 5H14.5V13H1.5V3Z" stroke="currentColor" stroke-width="1.5"/></svg>';

const EDIT_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 2L14 5L5 14H2V11L11 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.5 3.5L12.5 6.5" stroke="currentColor" stroke-width="1.5"/></svg>';

const DELETE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 3V1.5C5 1.22386 5.22386 1 5.5 1H10.5C10.7761 1 11 1.22386 11 1.5V3M2 3H14M12.5 3V13.5C12.5 13.7761 12.2761 14 12 14H4C3.72386 14 3.5 13.7761 3.5 13.5V3" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 6.5V10.5M9.5 6.5V10.5" stroke="currentColor" stroke-width="1.5"/></svg>';

const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 8L6 11L13 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CANCEL_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3L13 13M13 3L3 13" stroke="currentColor" stroke-width="1.5"/></svg>';

const ADD_FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 3V13M3 8H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const COLOR_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="10" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="10" r="1" fill="currentColor"/><circle cx="10" cy="10" r="1" fill="currentColor"/><path d="M5 12C5.5 13 6.5 13.5 8 13.5C9.5 13.5 10.5 13 11 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const EXPAND_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// カラーパレット
const COLOR_PALETTE = [
  // Row 1: 暖色系から寒色系へ
  { name: 'Red', value: '#e74c3c' },
  { name: 'Orange', value: '#e67e22' },
  { name: 'Yellow', value: '#f1c40f' },
  { name: 'Green', value: '#2ecc71' },
  { name: 'Cyan', value: '#1abc9c' },
  { name: 'Blue', value: '#3498db' },
  // Row 2: その他のカラー
  { name: 'Purple', value: '#9b59b6' },
  { name: 'Pink', value: '#ff69b4' },
  { name: 'Magenta', value: '#e91e63' },
  { name: 'Brown', value: '#8b4513' },
  { name: 'Gray', value: '#95a5a6' },
  { name: 'White', value: '#ffffff' }
];

function buildDisplayNameMap(allPaths) {
  const map = {};
  allPaths.forEach(filePath => {
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1] || filePath;
    const duplicates = allPaths.filter(p => (p.split('/').pop() || p) === fileName && p !== filePath);
    if (duplicates.length === 0) { map[filePath] = fileName; return; }
    if (parts.length === 1) { map[filePath] = '(root)/' + fileName; return; }
    for (let depth = 1; depth < parts.length; depth++) {
      const candidate = parts.slice(parts.length - 1 - depth).join('/');
      const isUnique = duplicates.every(p => {
        const pp = p.split('/');
        if (pp.length === 1) return true;
        return pp.slice(Math.max(0, pp.length - 1 - depth)).join('/') !== candidate;
      });
      if (isUnique) { map[filePath] = candidate; return; }
    }
    map[filePath] = filePath;
  });
  return map;
}

let favoriteDisplayNameMap = {};


// Form management
function toggleFavoriteForm() {
  const form = document.getElementById('favoriteForm');
  form.classList.toggle('active');
  if (form.classList.contains('active')) {
    // requestAnimationFrameを2回呼んでレンダリング完了を待つ
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        document.getElementById('filePath').focus();
      });
    });
  }
}

function cancelAddFavorite() {
  document.getElementById('favoriteForm').classList.remove('active');
  document.getElementById('filePath').value = '';
  document.getElementById('fileDesc').value = '';
  document.getElementById('fileIsRelative').checked = true;
  selectedVirtualFolderId = null;
  selectVirtualFolder(null, 'Uncategorized');
}

function addFavorite() {
  const path = document.getElementById('filePath').value;
  const description = document.getElementById('fileDesc').value;
  const isRelative = document.getElementById('fileIsRelative').checked;
  const virtualFolderId = selectedVirtualFolderId;
  
  if (path) {
    vscode.postMessage({ 
      command: 'addFavorite', 
      path, 
      description,
      isRelative: isRelative,
      virtualFolderId: virtualFolderId
    });
    cancelAddFavorite();
  }
}

function quickAddCurrentFile() {
  vscode.postMessage({ command: 'quickAddCurrentFile' });
}

function addFileWithContext() {
  const form = document.getElementById('favoriteForm');
  if (form && form.classList.contains('active')) {
    cancelAddFavorite();
  } else {
    vscode.postMessage({ command: 'addFileWithContext' });
  }
}

function addFileToFolder(folderId) {
  document.querySelectorAll('.add-form').forEach(f => f.classList.remove('active'));
  const form = document.getElementById('favoriteForm');
  if (!form) return;
  form.classList.add('active');
  const folder = virtualFolders.find(f => f.id === folderId);
  if (folder) { selectVirtualFolder(folder.id, folder.name); }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const filePathInput = document.getElementById('filePath');
      if (filePathInput) { filePathInput.focus(); }
    });
  });
}

function toggleEditFavorite(path) {
  const form = document.getElementById('edit-fav-' + safeId(path));
  
  if (form && form.classList.contains('active')) {
    // 既に開いている場合はキャンセル
    cancelEditFavorite(path);
  } else {
    // 閉じている場合は開く
    startEditFavorite(path);
  }
}

function startEditFavorite(path) {
  document.querySelectorAll('.edit-form').forEach(f => f.classList.remove('active'));
  const form = document.getElementById('edit-fav-' + safeId(path));
  if (form) { 
    form.classList.add('active'); 
    editingFavorite = path;
    
    // フォームが見える位置にスクロール
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
    
    // 念のため少し遅延してフォーカス（ダブルクリックの2回目クリックの影響を避ける）
    setTimeout(() => {
      const pathInput = form.querySelector('.edit-path');
      if (pathInput) {
        pathInput.focus();
        pathInput.select(); // テキストを選択状態にする
      }
    }, 50); // 50msに短縮（クリック判別があるので短くてもOK）
  }
}

function saveEditFavorite(oldPath) {
  const form = document.getElementById('edit-fav-' + safeId(oldPath));
  if (!form) return;
  const newPath = form.querySelector('.edit-path').value;
  const description = form.querySelector('.edit-desc').value;
  vscode.postMessage({ command: 'editFavorite', oldPath, newPath, description });
  form.classList.remove('active');
  editingFavorite = null;
}

function cancelEditFavorite(path) {
  const form = document.getElementById('edit-fav-' + safeId(path));
  if (form) {
    form.classList.remove('active');
    // 入力内容をリセット（元のデータに戻す）
    if (allFavoritesData && allFavoritesData[path]) {
      const pathInput = form.querySelector('.edit-path');
      const descInput = form.querySelector('.edit-desc');
      if (pathInput) pathInput.value = path;
      if (descInput) descInput.value = allFavoritesData[path].description || '';
    }
  }
  editingFavorite = null;
}

function removeFavorite(path) { 
  vscode.postMessage({ command: 'removeFavorite', path }); 
}

function openFile(path, openToSide = false) { 
  vscode.postMessage({ 
    command: 'openFile', 
    path: path,
    openToSide: openToSide
  }); 
}

function toggleFolder(folderId) {
  const icon = document.getElementById('icon-' + folderId);
  const items = document.getElementById('items-' + folderId);
  if (!icon || !items) return;
  const wasExpanded = items.classList.contains('expanded');
  if (wasExpanded) {
    expandedFolders.delete(folderId);
    items.classList.remove('expanded');
    icon.classList.remove('expanded');
    icon.style.transform = 'rotate(0deg)';
    items.style.display = 'none';
  } else {
    expandedFolders.add(folderId);
    items.classList.add('expanded');
    icon.classList.add('expanded');
    icon.style.transform = 'rotate(90deg)';
    items.style.display = 'block';
  }
  saveState();
}

function filterFavorites() {
  const searchText = document.getElementById('favoriteSearch').value.toLowerCase();
  if (!allFavoritesData) return;
  
  if (searchText === '') {
    updateFavorites(allFavoritesData);
    return;
  }
  
  const filtered = {};
  Object.entries(allFavoritesData).forEach(([path, data]) => {
    const fileName = path.split('/').pop() || '';
    
    if (path.toLowerCase().includes(searchText) ||
        fileName.toLowerCase().includes(searchText) ||
        (data.description && data.description.toLowerCase().includes(searchText))) {
      filtered[path] = data;
    }
  });
  
  updateFavorites(filtered);
}

function updateFavorites(favorites) {
  const container = document.getElementById('favorites');
  const debug = document.getElementById('favoriteDebug');
  
  if (!favorites) {
    debug.textContent = 'ERROR';
    container.innerHTML = '<div class="empty-text">Error</div>';
    return;
  }
  
  const allPaths = allFavoritesData ? Object.keys(allFavoritesData) : Object.keys(favorites);
  favoriteDisplayNameMap = buildDisplayNameMap(allPaths);
  
  const entries = Object.entries(favorites);
  
  const folderFiles = {};
  const rootFiles = {};
  
  entries.forEach(([path, data]) => {
    const virtualFolderId = data.virtualFolderId;
    if (virtualFolderId) {
      if (!folderFiles[virtualFolderId]) {
        folderFiles[virtualFolderId] = {};
      }
      folderFiles[virtualFolderId][path] = data;
    } else {
      rootFiles[path] = data;
    }
  });
  
  const rootCount = Object.keys(rootFiles).length;
  const folderCount = entries.length - rootCount;
  debug.textContent = entries.length + ' files (' + folderCount + ' in folders, ' + rootCount + ' uncategorized)';
  
  container.innerHTML = '';
  
  // 初回判定（expandedFoldersが空 = まだユーザーが手動で開閉していない）
  const isFirstRender = expandedFolders.size === 0;
  const expandState = window.favoritesDefaultExpandState || favoritesDefaultExpandState;
  if (isFirstRender && expandState === 'expanded') {
    // 全フォルダを展開状態にする
    virtualFolders.forEach(folder => {
      const folderId = safeId('vf-' + folder.id);
      expandedFolders.add(folderId);
    });
  }
  
  const rootFolders = virtualFolders
    .filter(f => !f.parentId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  
  rootFolders.forEach(folder => {
    const files = folderFiles[folder.id] || {};
    renderVirtualFolder(folder, files, container, 0, folderFiles, new Set());
  });
  
  if (Object.keys(rootFiles).length > 0) {
    renderRootFiles(rootFiles, container);
  }
  
  if (entries.length === 0 && virtualFolders.length === 0) {
    container.innerHTML = '<div class="empty-text">No favorites yet.<br><br>Click "+ New Virtual Folder" to organize your files,<br>or "+ Add File" to get started.</div>';
  }
}

function renderVirtualFolder(folder, files, container, depth = 0, allFolderFiles = {}, visited = new Set()) {
  // 循環参照ガード：同じフォルダIDを2度処理しない
  if (visited.has(folder.id)) return;
  visited.add(folder.id);
  const folderId = safeId('vf-' + folder.id);
  const isExpanded = expandedFolders.has(folderId);
  const fileCount = Object.keys(files).length;
  
  const childFolders = virtualFolders.filter(f => f.parentId === folder.id);
  const totalCount = fileCount + childFolders.length;
  
  const folderDiv = document.createElement('div');
  folderDiv.className = 'folder-group';
  folderDiv.setAttribute('data-folder-id', folder.id);
  folderDiv.style.marginLeft = (depth * 16) + 'px';
  
  // Drop イベントのみ（draggable は dragHandle に移動）
  folderDiv.addEventListener('dragover', handleFolderDragOver);
  folderDiv.addEventListener('dragleave', handleFolderDragLeave);
  folderDiv.addEventListener('drop', (e) => handleFolderDrop(e, folder.id));
  
  const headerDiv = document.createElement('div');
  headerDiv.className = 'folder-header';
  
  const isEditing = editingFolderId === folder.id;
  
  if (isEditing) {
    renderFolderEditMode(headerDiv, folder, folderId);
  } else {
    renderFolderNormalMode(headerDiv, folder, folderId, totalCount, isExpanded);
  }
  
  const itemsDiv = document.createElement('div');
  itemsDiv.id = 'items-' + folderId;
  itemsDiv.className = 'folder-items' + (isExpanded ? ' expanded' : '');
  itemsDiv.style.display = isExpanded ? 'block' : 'none';
  
  if (creatingSubfolderForId === folder.id) {
    const subfolderForm = document.createElement('div');
    subfolderForm.className = 'subfolder-create-form';
    subfolderForm.style.cssText = 'display: flex; align-items: center; gap: 4px; padding: 4px 8px; margin: 4px 0; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px;';
    
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'New folder name...';
    input.style.cssText = 'flex: 1; background: transparent; border: none; color: var(--vscode-input-foreground); font-size: 11px; outline: none;';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        saveSubfolder(folder.id, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelSubfolderCreation();
      }
    });
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.innerHTML = CHECK_ICON;
    saveBtn.title = 'Create';
    saveBtn.onclick = () => saveSubfolder(folder.id, input.value);
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.innerHTML = CANCEL_ICON;
    cancelBtn.title = 'Cancel';
    cancelBtn.onclick = cancelSubfolderCreation;
    
    subfolderForm.appendChild(input);
    subfolderForm.appendChild(saveBtn);
    subfolderForm.appendChild(cancelBtn);
    
    itemsDiv.appendChild(subfolderForm);
    
    setTimeout(() => input.focus(), 0);
  }
  
  // 子フォルダを order でソート
  const sortedChildFolders = childFolders.sort((a, b) => (a.order || 0) - (b.order || 0));
  
  sortedChildFolders.forEach(childFolder => {
    const childFiles = allFolderFiles[childFolder.id] || {};
    renderVirtualFolder(childFolder, childFiles, itemsDiv, depth + 1, allFolderFiles, visited);
  });
  
  // ファイルを fileOrder でソート
  const folderKey = folder.id;
  let fileOrder = (window.favoritesMeta && window.favoritesMeta.fileOrder && window.favoritesMeta.fileOrder[folderKey]) || Object.keys(files);
  
  // fileOrder から存在しないファイルを削除（クリーンアップ）
  fileOrder = fileOrder.filter(path => files[path]);
  
  // fileOrder に存在するファイルを順番通りにレンダリング
  fileOrder.forEach(path => {
    if (files[path]) {
      renderFavoriteFile(path, files[path], itemsDiv, folder.id);
    }
  });
  
  // fileOrder に含まれていない新しいファイルがあれば末尾に追加
  Object.keys(files).forEach(path => {
    if (!fileOrder.includes(path)) {
      renderFavoriteFile(path, files[path], itemsDiv, folder.id);
    }
  });
  
  folderDiv.appendChild(headerDiv);
  folderDiv.appendChild(itemsDiv);
  container.appendChild(folderDiv);
}

function renderFolderNormalMode(headerDiv, folder, folderId, totalCount, isExpanded) {
  const iconSpan = document.createElement('span');
  iconSpan.id = 'icon-' + folderId;
  iconSpan.className = 'folder-icon' + (isExpanded ? ' expanded' : '');
  iconSpan.innerHTML = EXPAND_ICON;
  iconSpan.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; width: 16px; transition: transform 0.2s;';
  if (isExpanded) {
    iconSpan.style.transform = 'rotate(90deg)';
  }
  
  const folderColor = folder.color || 'currentColor';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'folder-name';
  nameSpan.style.color = folderColor;
  nameSpan.innerHTML =
    '<span style="flex-shrink:0;display:inline-flex;align-items:center;">' + FOLDER_ICON + '</span>' +
    '<span style="flex:1;min-width:0;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(folder.name) + '</span>';
  nameSpan.style.cursor = 'pointer';
  nameSpan.style.flex = '1';

  // CSS の display:none → display:flex (hover) で制御。inline style 不要
  const buttonsSpan = document.createElement('span');
  buttonsSpan.className = 'folder-buttons';

  const countSpan = document.createElement('span');
  countSpan.className = 'folder-count';
  countSpan.style.flexShrink = '0';
  countSpan.textContent = totalCount;

  const addBtn = createButton(ADD_FOLDER_ICON, 'Add File to Folder', (e) => showAddFilePopup(e, folder.id));
  const editBtn = createButton(EDIT_ICON, 'Rename Folder', () => startFolderRename(folder.id));
  const colorBtn = createButton(COLOR_ICON, 'Change Color', (e) => showColorPicker(e, folder.id));
  const deleteBtn = createButton(DELETE_ICON, 'Delete Folder', () => deleteVirtualFolder(folder.id));

  buttonsSpan.appendChild(addBtn);
  buttonsSpan.appendChild(editBtn);
  buttonsSpan.appendChild(colorBtn);
  buttonsSpan.appendChild(deleteBtn);

  // 順序: name(flex:1 省略可) → buttons(hover時flex) → count(右端固定)
  // ホバー時にボタンが出るとその分 name が縮んで省略表示になる
  headerDiv.appendChild(iconSpan);
  headerDiv.appendChild(nameSpan);
  headerDiv.appendChild(buttonsSpan);
  headerDiv.appendChild(countSpan);
  
  // draggable設定（シンプル版）
  headerDiv.draggable = true;
  
  headerDiv.addEventListener('dragstart', (e) => {
    // ボタンエリアからのドラッグは無視
    if (e.target.closest('.folder-buttons')) {
      e.preventDefault();
      return;
    }
    handleFolderDragStart(e, folder.id, folder.parentId);
  });
  
  headerDiv.addEventListener('dragend', (e) => {
    handleFolderDragEnd(e);
  });
  
  // クリックでトグル
  headerDiv.addEventListener('click', (e) => {
    if (!e.target.closest('.folder-buttons')) {
      toggleFolder(folderId);
    }
  });
}

function renderFolderEditMode(headerDiv, folder, folderId) {
  headerDiv.style.cssText = 'display: flex; align-items: center; gap: 4px; padding: 4px 6px;';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.value = folder.name;
  input.style.cssText = 'flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 2px 6px; font-size: 12px; border-radius: 2px;';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      saveFolderRename(folder.id, input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelFolderRename();
    }
  });
  
  const saveBtn = createButton(CHECK_ICON, 'Save', () => saveFolderRename(folder.id, input.value));
  const cancelBtn = createButton(CANCEL_ICON, 'Cancel', cancelFolderRename);
  
  headerDiv.appendChild(input);
  headerDiv.appendChild(saveBtn);
  headerDiv.appendChild(cancelBtn);
  
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function createButton(content, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.innerHTML = content;
  btn.title = title;
  btn.onclick = (e) => {
    e.stopPropagation();
    onClick(e);
  };
  return btn;
}

function startFolderRename(folderId) {
  editingFolderId = folderId;
  updateFavorites(allFavoritesData);
}

function saveFolderRename(folderId, newName) {
  if (newName && newName.trim()) {
    vscode.postMessage({
      command: 'renameVirtualFolder',
      id: folderId,
      newName: newName.trim()
    });
  }
  editingFolderId = null;
}

function cancelFolderRename() {
  editingFolderId = null;
  updateFavorites(allFavoritesData);
}

function startSubfolderCreation(parentId) {
  creatingSubfolderForId = parentId;
  const folderId = safeId('vf-' + parentId);
  expandedFolders.add(folderId);
  updateFavorites(allFavoritesData);
}

function saveSubfolder(parentId, name) {
  if (name && name.trim()) {
    vscode.postMessage({
      command: 'createVirtualFolder',
      name: name.trim(),
      parentId: parentId
    });
  }
  creatingSubfolderForId = null;
}

function cancelSubfolderCreation() {
  creatingSubfolderForId = null;
  updateFavorites(allFavoritesData);
}

function showColorPicker(event, folderId) {
  event.stopPropagation();
  
  // トグル機能：同じフォルダなら閉じる
  if (currentColorPickerFolderId === folderId) {
    document.querySelectorAll('.color-picker-dropdown').forEach(el => el.remove());
    currentColorPickerFolderId = null;
    return;
  }
  
  // 既存のピッカーを削除
  document.querySelectorAll('.color-picker-dropdown').forEach(el => el.remove());
  currentColorPickerFolderId = folderId;
  
  const picker = document.createElement('div');
  picker.className = 'color-picker-dropdown';
  picker.style.cssText = 'position: fixed; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 6px; padding: 8px; z-index: 10000; box-shadow: 0 4px 12px rgba(0,0,0,0.4); width: 200px;';
  
  const rect = event.target.closest('.btn').getBoundingClientRect(); // 🔧 FIX: ボタン要素を確実に取得
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  
  let top = rect.bottom + 4;
  let left = rect.left;
  
  if (top + 120 > viewportHeight) top = rect.top - 124;
  if (left + 200 > viewportWidth) left = viewportWidth - 204;
  
  picker.style.left = Math.max(4, left) + 'px';
  picker.style.top = Math.max(4, top) + 'px';
  
  // カラーグリッド（6列 x 2行）
  const colorGrid = document.createElement('div');
  colorGrid.style.cssText = 'display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; margin-bottom: 6px;';
  
  COLOR_PALETTE.forEach(color => {
    const colorBtn = document.createElement('button');
    colorBtn.style.cssText = 'width: 24px; height: 24px; border: 2px solid var(--vscode-input-border); border-radius: 50%; cursor: pointer; background: ' + color.value + '; transition: transform 0.1s, border-color 0.1s; padding: 0;';
    colorBtn.title = color.name;
    
    // 白色と灰色は枠線を濃くする
    if (color.value === '#ffffff' || color.value === '#95a5a6') {
      colorBtn.style.borderColor = 'var(--vscode-descriptionForeground)';
    }
    
    colorBtn.addEventListener('mouseenter', () => {
      colorBtn.style.transform = 'scale(1.2)';
      colorBtn.style.borderColor = 'var(--vscode-focusBorder)';
    });
    
    colorBtn.addEventListener('mouseleave', () => {
      colorBtn.style.transform = 'scale(1)';
      if (color.value === '#ffffff' || color.value === '#95a5a6') {
        colorBtn.style.borderColor = 'var(--vscode-descriptionForeground)';
      } else {
        colorBtn.style.borderColor = 'var(--vscode-input-border)';
      }
    });
    
    colorBtn.onclick = () => {
      vscode.postMessage({ command: 'changeFolderColor', id: folderId, color: color.value });
      picker.remove();
      currentColorPickerFolderId = null;
    };
    
    colorGrid.appendChild(colorBtn);
  });
  
  picker.appendChild(colorGrid);
  
  // ボタンコンテナ（Clear ColorとCancelを横並び）
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = 'display: flex; gap: 4px;';
  
  // Clear Colorボタン
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear Color';
  clearBtn.style.cssText = 'flex: 1; padding: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; font-size: 10px;';
  
  clearBtn.onmouseenter = () => {
    clearBtn.style.background = 'var(--vscode-button-secondaryHoverBackground)';
  };
  
  clearBtn.onmouseleave = () => {
    clearBtn.style.background = 'var(--vscode-button-secondaryBackground)';
  };
  
  clearBtn.onclick = () => {
    vscode.postMessage({ command: 'changeFolderColor', id: folderId, color: 'currentColor' });
    picker.remove();
    currentColorPickerFolderId = null;
  };
  
  // Cancelボタン
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'flex: 1; padding: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; font-size: 10px;';
  
  cancelBtn.onmouseenter = () => {
    cancelBtn.style.background = 'var(--vscode-button-secondaryHoverBackground)';
  };
  
  cancelBtn.onmouseleave = () => {
    cancelBtn.style.background = 'var(--vscode-button-secondaryBackground)';
  };
  
  cancelBtn.onclick = () => {
    picker.remove();
    currentColorPickerFolderId = null;
  };
  
  buttonContainer.appendChild(clearBtn);
  buttonContainer.appendChild(cancelBtn);
  picker.appendChild(buttonContainer);
  
  document.body.appendChild(picker);
  
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!picker.contains(e.target)) {
        picker.remove();
        currentColorPickerFolderId = null;
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 0);
}

function showAddFilePopup(event, folderId) {
  event.stopPropagation();

  // 🔧 FIX: トグル機能を追加
  // 同じフォルダのポップアップが既に開いている場合は閉じる
  if (currentAddFilePopupFolderId === folderId) {
    document.querySelectorAll('.add-file-popup').forEach(el => el.remove());
    currentAddFilePopupFolderId = null;
    return;
  }

  // 既存のポップアップを削除
  document.querySelectorAll('.add-file-popup').forEach(el => el.remove());

  // 🔧 NEW: 現在のフォルダIDを記録
  currentAddFilePopupFolderId = folderId;
  
  const popup = document.createElement('div');
  popup.className = 'add-file-popup';
  popup.style.cssText = 'position: fixed; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 6px; padding: 10px; z-index: 10000; box-shadow: 0 4px 12px rgba(0,0,0,0.4); min-width: 280px;';
  
  const rect = event.target.closest('.btn').getBoundingClientRect(); // 🔧 FIX: ボタン要素を確実に取得
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  
  let top = rect.bottom + 4;
  let left = rect.left;
  
  // ポップアップが画面外に出ないように調整
  if (top + 200 > viewportHeight) top = rect.top - 204;
  if (left + 280 > viewportWidth) left = viewportWidth - 284;
  
  popup.style.left = Math.max(4, left) + 'px';
  popup.style.top = Math.max(4, top) + 'px';
  
  // タイトル
  const title = document.createElement('div');
  title.textContent = 'Add File to Folder';
  title.style.cssText = 'font-weight: bold; margin-bottom: 8px; font-size: 12px;';
  popup.appendChild(title);
  
  // File Path入力
  const pathLabel = document.createElement('label');
  pathLabel.textContent = 'File Path:';
  pathLabel.style.cssText = 'display: block; font-size: 11px; margin-bottom: 3px;';
  popup.appendChild(pathLabel);
  
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.placeholder = 'e.g., src/components/Header.tsx';
  pathInput.style.cssText = 'width: 100%; padding: 4px; margin-bottom: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 11px; box-sizing: border-box;';
  popup.appendChild(pathInput);
  
  // Description入力
  const descLabel = document.createElement('label');
  descLabel.textContent = 'Description (optional):';
  descLabel.style.cssText = 'display: block; font-size: 11px; margin-bottom: 3px;';
  popup.appendChild(descLabel);
  
  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.placeholder = 'Optional description';
  descInput.style.cssText = 'width: 100%; padding: 4px; margin-bottom: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 11px; box-sizing: border-box;';
  popup.appendChild(descInput);
  
  // Relative Path チェックボックス
  const checkboxContainer = document.createElement('div');
  checkboxContainer.style.cssText = 'display: flex; align-items: center; margin-bottom: 10px;';
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'popup-relative-checkbox-' + folderId; // 🔧 FIX: 一意なIDを付与
  checkbox.checked = settings.defaultPathType === 'relative';
  checkbox.style.cssText = 'margin-right: 6px;';
  
  const checkboxLabel = document.createElement('label');
  checkboxLabel.htmlFor = 'popup-relative-checkbox-' + folderId;
  checkboxLabel.textContent = 'Relative Path';
  checkboxLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
  
  checkboxContainer.appendChild(checkbox);
  checkboxContainer.appendChild(checkboxLabel);
  popup.appendChild(checkboxContainer);
  
  // 🔧 FIX: ポップアップを閉じる共通関数
  const closePopup = () => {
    popup.remove();
    currentAddFilePopupFolderId = null;
  };

  // ボタンコンテナ
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = 'display: flex; gap: 6px;';
  
  // Addボタン
  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add';
  addBtn.style.cssText = 'flex: 1; padding: 5px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; font-size: 11px;';
  
  addBtn.onmouseenter = () => {
    addBtn.style.background = 'var(--vscode-button-hoverBackground)';
  };
  
  addBtn.onmouseleave = () => {
    addBtn.style.background = 'var(--vscode-button-background)';
  };
  
  const submitForm = () => {
    const path = pathInput.value.trim();
    if (!path) {
      pathInput.style.borderColor = 'var(--vscode-inputValidation-errorBorder)';
      pathInput.focus();
      return;
    }
    
    vscode.postMessage({
      command: 'addFavorite',
      path: path,
      description: descInput.value.trim(),
      isRelative: checkbox.checked,
      folderId: folderId
    });
    
    closePopup();
  };
  
  addBtn.onclick = submitForm;
  
  // Cancelボタン
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'flex: 1; padding: 5px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; font-size: 11px;';
  
  cancelBtn.onmouseenter = () => {
    cancelBtn.style.background = 'var(--vscode-button-secondaryHoverBackground)';
  };
  
  cancelBtn.onmouseleave = () => {
    cancelBtn.style.background = 'var(--vscode-button-secondaryBackground)';
  };
  
  cancelBtn.onclick = () => {
    closePopup();
  };
  
  buttonContainer.appendChild(addBtn);
  buttonContainer.appendChild(cancelBtn);
  popup.appendChild(buttonContainer);
  
  document.body.appendChild(popup);
  
  // Enterキーでsubmit
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitForm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePopup();
    }
  });
  
  descInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitForm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePopup();
    }
  });
  
  // フォーカスをFile Path入力に
  setTimeout(() => pathInput.focus(), 0);
  
  // 外部クリックで閉じる
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!popup.contains(e.target)) {
        closePopup();
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);

    // 🔧 NEW: ポップアップが削除されたときにイベントリスナーをクリーンアップ
    const observer = new MutationObserver((mutations) => {
      if (!document.body.contains(popup)) {
        document.removeEventListener('click', closeHandler);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, 0);
}


function deleteVirtualFolder(id) {
  const folder = virtualFolders.find(f => f.id === id);
  if (!folder) return;
  
  vscode.postMessage({ 
    command: 'deleteVirtualFolder', 
    id: id, 
    folderName: folder.name 
  });
}

function renderRootFiles(files, container) {
  const uncategorizedDiv = document.createElement('div');
  uncategorizedDiv.className = 'folder-group';
  uncategorizedDiv.setAttribute('data-folder-id', 'null');
  uncategorizedDiv.style.marginLeft = '0px';
  
  uncategorizedDiv.addEventListener('dragover', handleFolderDragOver);
  uncategorizedDiv.addEventListener('dragleave', handleFolderDragLeave);
  uncategorizedDiv.addEventListener('drop', (e) => handleFolderDrop(e, null));
  
  const folderId = safeId('vf-uncategorized');
  const isExpanded = expandedFolders.has(folderId);
  
  const headerDiv = document.createElement('div');
  headerDiv.className = 'folder-header';
  
  const iconSpan = document.createElement('span');
  iconSpan.id = 'icon-' + folderId;
  iconSpan.className = 'folder-icon' + (isExpanded ? ' expanded' : '');
  iconSpan.innerHTML = EXPAND_ICON;
  iconSpan.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; width: 16px; transition: transform 0.2s;';
  if (isExpanded) {
    iconSpan.style.transform = 'rotate(90deg)';
  }
  
  const nameSpan = document.createElement('span');
  nameSpan.className = 'folder-name';
  nameSpan.style.color = 'var(--vscode-descriptionForeground)';
  nameSpan.innerHTML =
    '<span style="flex-shrink:0;display:inline-flex;align-items:center;">' + FOLDER_ICON + '</span>' +
    '<span style="flex:1;min-width:0;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Uncategorized</span>';
  nameSpan.style.flex = '1';

  const countSpan = document.createElement('span');
  countSpan.className = 'folder-count';
  countSpan.style.flexShrink = '0';
  countSpan.textContent = Object.keys(files).length;

  headerDiv.appendChild(iconSpan);
  headerDiv.appendChild(nameSpan);
  headerDiv.appendChild(countSpan);
  
  headerDiv.onclick = () => toggleFolder(folderId);
  
  const itemsDiv = document.createElement('div');
  itemsDiv.id = 'items-' + folderId;
  itemsDiv.className = 'folder-items' + (isExpanded ? ' expanded' : '');
  itemsDiv.style.display = isExpanded ? 'block' : 'none';
  
  // ファイルを fileOrder でソート
  const folderKey = '(root)';
  let fileOrder = (window.favoritesMeta && window.favoritesMeta.fileOrder && window.favoritesMeta.fileOrder[folderKey]) || Object.keys(files);
  
  // fileOrder から存在しないファイルを削除（クリーンアップ）
  fileOrder = fileOrder.filter(path => files[path]);
  
  // fileOrder に存在するファイルを順番通りにレンダリング
  fileOrder.forEach(path => {
    if (files[path]) {
      renderFavoriteFile(path, files[path], itemsDiv, null);
    }
  });
  
  // fileOrder に含まれていない新しいファイルがあれば末尾に追加
  Object.keys(files).forEach(path => {
    if (!fileOrder.includes(path)) {
      renderFavoriteFile(path, files[path], itemsDiv, null);
    }
  });
  
  uncategorizedDiv.appendChild(headerDiv);
  uncategorizedDiv.appendChild(itemsDiv);
  container.appendChild(uncategorizedDiv);
}

function renderFavoriteFile(path, data, container, folderId) {
  const itemDiv = document.createElement('div');
  itemDiv.className = 'item';
  itemDiv.draggable = true;
  
  itemDiv.addEventListener('dragstart', (e) => handleFileDragStart(e, path, folderId));
  itemDiv.addEventListener('dragend', handleFileDragEnd);
  itemDiv.addEventListener('dragover', (e) => handleFileDragOver(e, path, folderId));
  itemDiv.addEventListener('dragleave', handleFileDragLeave);
  itemDiv.addEventListener('drop', (e) => handleFileDrop(e, path, folderId));
  
  const fileName = favoriteDisplayNameMap[path] || path.split('/').pop() || path;
  const fileIconSrc = fileIcons[path] || '';
  const fileIconHtml = fileIconSrc 
    ? '<img src="' + fileIconSrc + '" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;" />' 
    : '📄 ';
  
  const contentDiv = document.createElement('div');
  contentDiv.className = 'item-content';
  
  // 🔧 FIX: ファイルを開く処理は hover の光る範囲（.item 全体）と一致させるため、
  // 下記の itemDiv 全体へのクリックリスナーに統合した（Ctrl/Cmd+クリックで横に開くのは維持）。
  
  contentDiv.innerHTML = `
    <div class="item-file">${fileIconHtml}${escapeHtml(fileName)}</div>
    ${data.description ? '<div class="item-desc">' + escapeHtml(data.description) + '</div>' : ''}
  `;
  
  const buttonsDiv = document.createElement('div');
  buttonsDiv.className = 'item-buttons';
  // ホバー時のみ表示
  buttonsDiv.style.opacity = '0';
  buttonsDiv.style.transition = 'opacity 0.2s';
  
  const editBtn = createButton(EDIT_ICON, 'Edit', () => toggleEditFavorite(path));
  const deleteBtn = createButton(DELETE_ICON, 'Remove', () => removeFavorite(path));
  
  buttonsDiv.appendChild(editBtn);
  buttonsDiv.appendChild(deleteBtn);
  
  itemDiv.appendChild(contentDiv);
  itemDiv.appendChild(buttonsDiv);
  
  // 🔧 FIX: hover で光る範囲（.item 全体）をクリック対象にし、ファイルを開く＋選択状態にする。
  // 編集・削除ボタン（.item-buttons）上のクリックは無視する。
  itemDiv.addEventListener('click', (e) => {
    if (e.target.closest('.item-buttons')) return;
    if (e.detail === 1) {
      const openToSide = e.ctrlKey || e.metaKey;
      openFile(path, openToSide);

      selectedItemPath = path;
      selectedFolderId = null;

      document.querySelectorAll('.folder-header').forEach(el => el.classList.remove('selected'));
      document.querySelectorAll('.item').forEach(el => el.classList.remove('selected'));
      itemDiv.classList.add('selected');
    }
  });
  
  // ホバーイベント
  itemDiv.addEventListener('mouseenter', () => {
    buttonsDiv.style.opacity = '1';
  });
  itemDiv.addEventListener('mouseleave', () => {
    buttonsDiv.style.opacity = '0';
  });
  
  const editForm = document.createElement('div');
  editForm.id = 'edit-fav-' + safeId(path);
  editForm.className = 'edit-form';
  editForm.innerHTML = `
    <input type="text" class="edit-path" placeholder="File path" value="${escapeHtml(path)}" />
    <input type="text" class="edit-desc" placeholder="Description" value="${escapeHtml(data.description || '')}" />
    <div class="edit-form-buttons">
      <button class="save-btn">Save</button>
      <button class="cancel-btn">Cancel</button>
    </div>
  `;
  
  // input要素に直接キーハンドラーを追加（DOMが生成された後）
  setTimeout(() => {
    // 🔧 FIX: ボタンイベントをDOMイベントとして追加（XSS対策)
    const saveBtn = editForm.querySelector('.save-btn');
    const cancelBtn = editForm.querySelector('.cancel-btn');
    
    if (saveBtn) saveBtn.onclick = () => saveEditFavorite(path);
    if (cancelBtn) cancelBtn.onclick = () => cancelEditFavorite(path);
    
    // キーボードイベント
    const pathInput = editForm.querySelector('.edit-path');
    const descInput = editForm.querySelector('.edit-desc');
    
    const keyHandler = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        saveEditFavorite(path);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelEditFavorite(path);
      }
    };
    
    if (pathInput) pathInput.addEventListener('keydown', keyHandler);
    if (descInput) descInput.addEventListener('keydown', keyHandler);
  }, 0);
  
  const wrapper = document.createElement('div');
  wrapper.appendChild(itemDiv);
  wrapper.appendChild(editForm);
  container.appendChild(wrapper);
}

// ドラッグ&ドロップハンドラー

// プレースホルダー表示（並び替え用）
// DOM挿入をやめてborderスタイルで表現（DOM変更による位置ズレ・flickeringを根本解消）
function showPlaceholder(position, element) {
  if (lastPlaceholderTarget === element && lastPlaceholderPosition === position) return;
  
  clearPlaceholderStyle();
  
  const header = element.querySelector('.folder-header') || element;
  const borderStyle = '2px solid var(--vscode-focusBorder)';
  if (position === 'before') {
    header.style.borderTop = borderStyle;
    header.style.borderBottom = '';
  } else {
    header.style.borderTop = '';
    header.style.borderBottom = borderStyle;
  }
  
  dragOverTarget = element;
  insertPosition = position;
  lastPlaceholderTarget = element;
  lastPlaceholderPosition = position;
}

function clearPlaceholderStyle() {
  document.querySelectorAll('.folder-group').forEach(el => {
    const header = el.querySelector('.folder-header') || el;
    header.style.borderTop = '';
    header.style.borderBottom = '';
  });
  // ファイルアイテムの並び替え用borderもクリア（通過した全.itemに青線が残るバグ対策）
  document.querySelectorAll('.item').forEach(el => {
    el.style.borderTop = '';
    el.style.borderBottom = '';
  });
}

function removePlaceholder() {
  clearPlaceholderStyle();
  dragOverTarget = null;
  insertPosition = null;
  lastPlaceholderTarget = null;
  lastPlaceholderPosition = null;
}

function handleFileDragStart(e, filePath, fromFolderId) {
  e.stopPropagation(); // 親要素への伝播を防ぐ（重要！）
  draggedFile = filePath;
  draggedFolder = null; // フォルダドラッグをリセット
  draggedFolderParentId = null;
  draggedFromFolderId = fromFolderId;
  currentDragMode = null;
  e.currentTarget.style.opacity = '0.5';
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', filePath);
}

function handleFileDragEnd(e) {
  e.currentTarget.style.opacity = '1';
  draggedFile = null;
  draggedFromFolderId = null;
  removePlaceholder();
}

// ファイル要素上でのdragover（並び替え用）
function handleFileDragOver(e, targetPath, targetFolderId) {
  if (!draggedFile) return; // ファイルドラッグ中のみ
  if (draggedFile === targetPath) return; // 自分自身は無視
  
  // 同一フォルダ内の場合のみ並び替え処理
  if (draggedFromFolderId === targetFolderId) {
    e.preventDefault();
    e.stopPropagation();
    
    // 上半分か下半分かで判定
    const rect = e.currentTarget.getBoundingClientRect();
    const midPoint = rect.top + rect.height / 2;
    const position = e.clientY < midPoint ? 'before' : 'after';
    
    showPlaceholder(position, e.currentTarget);
    e.dataTransfer.dropEffect = 'move';
  }
  // 異なるフォルダの場合はイベントを伝播させて、フォルダヘッダーが処理できるようにする
}

function handleFileDragLeave(e) {
  // 要素から完全に離れた場合のみクリア
  if (!e.currentTarget.contains(e.relatedTarget)) {
    removePlaceholder();
  }
}

function handleFileDrop(e, targetPath, targetFolderId) {
  if (!draggedFile) return;
  if (draggedFile === targetPath) return;
  
  // 同一フォルダ内の場合のみ並び替え処理
  if (draggedFromFolderId === targetFolderId) {
    e.preventDefault();
    e.stopPropagation();
    
    vscode.postMessage({
      command: 'reorderFilesInFolder',
      folderId: targetFolderId,
      draggedFile: draggedFile,
      targetFile: targetPath,
      position: insertPosition
    });
    
    removePlaceholder();
  }
  // 異なるフォルダの場合はイベントを伝播させて、フォルダヘッダーが処理する
}


function handleFolderDragStart(e, folderId, parentId) {
  e.stopPropagation();
  draggedFolder = folderId;
  draggedFile = null;
  draggedFolderParentId = parentId || null;
  draggedFromFolderId = null; // ファイル用変数はリセット
  currentDragMode = null;
  
  // ドラッグ中のフォルダを半透明に
  const folderElement = document.querySelector(`[data-folder-id="${folderId}"]`);
  if (folderElement) {
    folderElement.style.opacity = '0.4';
  }
  
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', folderId);
}

function handleFolderDragEnd(e) {
  if (draggedFolder) {
    const folderElement = document.querySelector(`[data-folder-id="${draggedFolder}"]`);
    if (folderElement) folderElement.style.opacity = '1';
  }
  
  document.querySelectorAll('.folder-group').forEach(folder => {
    folder.classList.remove('drag-over');
  });
  clearPlaceholderStyle();
  
  draggedFolder = null;
  draggedFolderParentId = null;
  currentDragMode = null;
  removePlaceholder();
}

function handleFolderDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  
  const folderGroup = e.currentTarget;
  const targetFolderId = folderGroup.getAttribute('data-folder-id');
  const actualTargetId = targetFolderId === 'null' ? null : targetFolderId;
  
  // ファイルをフォルダに移動（既存機能）
  if (draggedFile && !draggedFolder) {
    if (actualTargetId === draggedFromFolderId) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.folder-group').forEach(f => f.classList.remove('drag-over'));
    folderGroup.classList.add('drag-over');
    return;
  }
  
  // フォルダをドラッグ中
  if (draggedFolder && !draggedFile) {
    // 自分自身はスキップ
    if (actualTargetId === draggedFolder) {
      e.dataTransfer.dropEffect = 'none';
      removePlaceholder();
      document.querySelectorAll('.folder-group').forEach(f => f.classList.remove('drag-over'));
      return;
    }
    
    // folder-header の rect でカーソル位置を判定（子要素の影響を受けない）
    const headerEl = folderGroup.querySelector('.folder-header');
    const rect = (headerEl || folderGroup).getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const zoneSize = rect.height * 0.25;
    
    if (relY < zoneSize) {
      // 上25%: 前に挿入
      document.querySelectorAll('.folder-group').forEach(f => f.classList.remove('drag-over'));
      currentDragMode = 'before';
      showPlaceholder('before', folderGroup);
      e.dataTransfer.dropEffect = 'move';
    } else if (relY > rect.height - zoneSize) {
      // 下25%: 後ろに挿入
      document.querySelectorAll('.folder-group').forEach(f => f.classList.remove('drag-over'));
      currentDragMode = 'after';
      showPlaceholder('after', folderGroup);
      e.dataTransfer.dropEffect = 'move';
    } else {
      // 中央50%: フォルダ内に移動
      if (currentDragMode !== 'into' || lastPlaceholderTarget !== null) {
        clearPlaceholderStyle();
        document.querySelectorAll('.folder-group').forEach(f => f.classList.remove('drag-over'));
        folderGroup.classList.add('drag-over');
        currentDragMode = 'into';
        lastPlaceholderTarget = null;
        lastPlaceholderPosition = null;
      }
      e.dataTransfer.dropEffect = 'move';
    }
  }
}

function handleFolderDragLeave(e) {
  const folderGroup = e.currentTarget;
  const related = e.relatedTarget;
  
  if (!folderGroup.contains(related)) {
    folderGroup.classList.remove('drag-over');
    // border はそのまま維持（他の folderGroup に移った時に clearPlaceholderStyle で一括クリア）
  }
}

function handleFolderDrop(e, targetFolderId) {
  e.preventDefault();
  e.stopPropagation();
  
  const folderGroup = e.currentTarget;
  folderGroup.classList.remove('drag-over');
  
  // ファイルをフォルダに移動
  if (draggedFile && !draggedFolder) {
    if (targetFolderId === draggedFromFolderId) return;
    vscode.postMessage({
      command: 'moveFileToFolder',
      filePath: draggedFile,
      targetFolderId: targetFolderId
    });
    return;
  }
  
  // フォルダ操作
  if (draggedFolder && !draggedFile) {
    if (targetFolderId === draggedFolder) return;

    // drop時点でcursor位置を再計算してmodeを確定（dragoverの最終値が古い場合への保険）
    const headerEl = folderGroup.querySelector('.folder-header');
    const rect = (headerEl || folderGroup).getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const zoneSize = rect.height * 0.25;
    let resolvedMode;
    if (relY < zoneSize) {
      resolvedMode = 'before';
    } else if (relY > rect.height - zoneSize) {
      resolvedMode = 'after';
    } else {
      resolvedMode = 'into';
    }

    if (resolvedMode === 'into') {
      if (targetFolderId === draggedFolderParentId) return;
      vscode.postMessage({
        command: 'moveFolderToFolder',
        folderId: draggedFolder,
        targetParentId: targetFolderId
      });
    } else {
      // before / after: 並び替え
      const targetFolder = virtualFolders.find(f => f.id === targetFolderId);
      const targetParentId = targetFolder ? (targetFolder.parentId || null) : null;
      vscode.postMessage({
        command: 'reorderFolders',
        draggedFolderId: draggedFolder,
        targetFolderId: targetFolderId,
        position: resolvedMode,
        parentId: targetParentId
      });
    }
    
    removePlaceholder();
  }
}

// Virtual Folder管理
function toggleVirtualFolderForm() {
  const form = document.getElementById('virtualFolderForm');
  form.classList.toggle('active');
  if (form.classList.contains('active')) {
    const input = document.getElementById('virtualFolderName');
    input.focus();
    
    // Enterキーでフォルダ作成
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createVirtualFolder();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelVirtualFolderForm();
      }
    };
  }
}

function cancelVirtualFolderForm() {
  document.getElementById('virtualFolderForm').classList.remove('active');
  document.getElementById('virtualFolderName').value = '';
}

function createVirtualFolder() {
  const name = document.getElementById('virtualFolderName').value;
  if (name && name.trim()) {
    vscode.postMessage({ command: 'createVirtualFolder', name: name.trim(), createPath: true });
    cancelVirtualFolderForm();
  }
}

function toggleVirtualFolderSelect() {
  const options = document.getElementById('virtualFolderSelectOptions');
  if (!options) return;
  document.querySelectorAll('.custom-select-options').forEach(opt => {
    if (opt.id !== 'virtualFolderSelectOptions') opt.classList.remove('active');
  });
  options.classList.toggle('active');
}

function selectVirtualFolder(id, name) {
  const text = document.getElementById('virtualFolderSelectText');
  const options = document.getElementById('virtualFolderSelectOptions');
  if (text) text.textContent = name;
  if (options) options.classList.remove('active');
  selectedVirtualFolderId = id;
}

function updateVirtualFolderSelect() {
  const options = document.getElementById('virtualFolderSelectOptions');
  if (!options) return;
  
  options.innerHTML = '';
  
  const uncatOpt = document.createElement('div');
  uncatOpt.className = 'custom-select-option';
  uncatOpt.onclick = () => selectVirtualFolder(null, 'Uncategorized');
  uncatOpt.innerHTML = '<span>📂 Uncategorized</span>';
  options.appendChild(uncatOpt);
  
  if (virtualFolders.length > 0) {
    const separator = document.createElement('div');
    separator.style.cssText = 'border-top: 1px solid var(--vscode-menu-separatorBackground); margin: 4px 0;';
    options.appendChild(separator);
  }
  
  virtualFolders.forEach(folder => {
    const opt = document.createElement('div');
    opt.className = 'custom-select-option';
    opt.onclick = () => selectVirtualFolder(folder.id, folder.name);

    // 🔧 FIX(security): folder.color を文字列結合で style 属性に直接埋め込んでいたため、
    // " を含む値が万一混入すると属性から脱出できてしまう懸念があった。
    // CSSOM (style.color への直接代入) を使えば、不正な値は単に無視されるだけで安全。
    const colorSpan = document.createElement('span');
    colorSpan.style.color = folder.color || 'currentColor';
    colorSpan.innerHTML = FOLDER_ICON + ' ' + escapeHtml(folder.name);

    opt.appendChild(colorSpan);
    options.appendChild(opt);
  });
}

function switchFavoriteMode(mode) {
  currentFavoriteMode = mode;
  updateModeButtons();
  saveState();
  vscode.postMessage({ command: 'switchFavoriteMode', mode: mode });
}

function updateModeButtons() {
  const globalBtn = document.getElementById('globalModeBtn');
  const localBtn = document.getElementById('localModeBtn');
  
  if (globalBtn && localBtn) {
    globalBtn.classList.toggle('active', currentFavoriteMode === 'global');
    localBtn.classList.toggle('active', currentFavoriteMode === 'local');
  }
}