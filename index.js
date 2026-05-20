// ==========================================
// 1. SUPABASE INITIALIZATION
// ==========================================
const SUPABASE_URL = 'https://ycvoizbvjmibqklyfhfx.supabase.co/';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inljdm9pemJ2am1pYnFrbHlmaGZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDQ2OTMsImV4cCI6MjA5NDg4MDY5M30.2sT0BrwOjR5LUzlF4uEkhjdrcTUOG6t4zrWNfMABIls';

// Renamed to 'supabaseClient' to prevent naming collision with the CDN!
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==========================================
// 2. GLOBAL STATE
// ==========================================
let globalUser = null;
let globalStockpiles = [];
let globalInventories = {}; 
let globalValidItems = {};
let pendingActions = []; // Tracks changes before they are synced
let currentModalId = null;
let hasPromptedSync = false;

// ==========================================
// 3. AUTHENTICATION FLOW
// ==========================================
window.onload = async function() { 
    // Check if the user is already logged in when the page loads
    const { data: { session } } = await supabaseClient.auth.getSession();
    handleSessionState(session);

    // Listen for login/logout events automatically
    supabaseClient.auth.onAuthStateChange((event, session) => {
        handleSessionState(session);
    });
};

function handleSessionState(session) {
    const loginBtn = document.getElementById('loginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const tableBody = document.getElementById('tableBody');

    if (session) {
        globalUser = session.user;
        loginBtn.style.display = 'none';
        logoutBtn.style.display = 'block';
        
        // Show Discord name on the logout button
        const discordName = session.user.user_metadata.full_name || session.user.user_metadata.name || 'User';
        logoutBtn.innerText = `Logout (${discordName})`;
        
        // Enable search filters
        document.querySelectorAll('.filters input, .filters select').forEach(el => el.disabled = false);
        
        tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 30px;">⏳ Fetching database...</td></tr>';
        fetchDatabase(); 
    } else {
        globalUser = null;
        loginBtn.style.display = 'flex';
        logoutBtn.style.display = 'none';
        
        // Lock UI
        document.querySelectorAll('.filters input, .filters select').forEach(el => el.disabled = true);
        tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #64748b; padding: 30px;">🔒 Please log in using Discord to view the database.</td></tr>';
        document.getElementById('goalsSection').style.display = 'none';
    }
}

async function signInWithDiscord() {
    const { error } = await supabaseClient.auth.signInWithOAuth({ 
        provider: 'discord',
        options: {
            redirectTo: 'https://kristeal.github.io/DFO-logi-management/' 
        }
    });
    if (error) showToast(error.message, "error");
}

async function signOut() {
    await supabaseClient.auth.signOut();
    showToast("Successfully logged out.", "success");
    globalStockpiles = [];
    globalInventories = {};
}

// ==========================================
// 4. DATABASE FETCHING & RENDERING
// ==========================================
async function fetchDatabase() {
    // 1. Fetch all rows from the 'stockpiles' table
    const { data, error } = await supabaseClient
        .from('stockpiles')
        .select('*')
        .order('pinned', { ascending: false }); // Pinned items at the top

    if (error) {
        showToast("Failed to load database: " + error.message, "error");
        document.getElementById('tableBody').innerHTML = '<tr><td colspan="6" style="color:red; text-align:center;">Failed to connect to database.</td></tr>';
        return;
    }

    globalStockpiles = data;
    globalInventories = {};
    globalValidItems = {};

    // 2. Process the JSONB inventory column into our local memory format
    data.forEach(row => {
        // Supabase stores the JSON natively, so we just assign it!
        globalInventories[row.id] = row.inventory || [];
        
        // Build a list of valid items based on the type for the dropdowns
        if (!globalValidItems[row.type]) globalValidItems[row.type] = new Set();
        (row.inventory || []).forEach(item => {
            globalValidItems[row.type].add(item.name);
        });
    });

    renderAll();
    populateTypeDropdown();
}

function renderAll() {
    populateGoals();
    applyFilters();
    
    // Refresh modal if it's currently open
    if (currentModalId && document.getElementById('invModal').style.display === 'flex') {
        let sp = globalStockpiles.find(s => s.id === currentModalId);
        if (sp) openInventory(sp.id, sp.name, sp.type);
    }
}

// ==========================================
// 5. SYNC LOGIC (UPSERT & DELETE)
// ==========================================
function queueAction(actionObj) {
    pendingActions.push(actionObj);
    document.getElementById('syncText').innerText = `Unsynced Changes: ${pendingActions.length}`;
    document.getElementById('syncBar').classList.add('visible');
    
    if (!hasPromptedSync) {
        showToast("Change applied locally. Remember to click Sync!", "warning");
        hasPromptedSync = true;
    }
    renderAll();
}

function discardChanges() {
    pendingActions = [];
    hasPromptedSync = false;
    document.getElementById('syncBar').classList.remove('visible');
    showToast("Changes discarded.", "warning");
    fetchDatabase(); 
}

async function syncWithDatabase() {
    if (pendingActions.length === 0) return;
    document.getElementById('syncText').innerText = "Syncing with database, please wait...";

    // Condense actions (If a user modified and deleted the same row, just delete it)
    let toUpdate = new Set();
    let toDelete = new Set();

    pendingActions.forEach(act => {
        if (act.type === 'delete') {
            toDelete.add(act.id);
            toUpdate.delete(act.id);
        } else {
            if (!toDelete.has(act.id)) toUpdate.add(act.id);
        }
    });

    let hasError = false;

    // 1. Process Deletions
    for (let id of toDelete) {
        const { error } = await supabaseClient.from('stockpiles').delete().eq('id', id);
        if (error) hasError = true;
    }

    // 2. Process Updates (Supabase handles this with 'Upsert')
    for (let id of toUpdate) {
        let rowData = globalStockpiles.find(s => s.id === id);
        if (!rowData) continue;

        // Attach the latest inventory array back to the row
        rowData.inventory = globalInventories[id] || [];
        rowData.last_modified = new Date().toISOString();

        const { error } = await supabaseClient.from('stockpiles').upsert({
            id: rowData.id,
            hex: rowData.hex,
            poi: rowData.poi,
            type: rowData.type,
            name: rowData.name,
            pinned: rowData.pinned,
            inventory: rowData.inventory,
            last_modified: rowData.last_modified
        });
        if (error) hasError = true;
    }

    if (hasError) {
        showToast("Sync completed with some errors. Reloading data.", "error");
    } else {
        showToast("Database successfully synced!", "success");
    }

    // Clean up and reload
    pendingActions = [];
    hasPromptedSync = false;
    document.getElementById('syncBar').classList.remove('visible');
    fetchDatabase();
}

// ==========================================
// 6. UI MUTATORS & ACTIONS
// ==========================================
function actionTogglePinned(event, id) {
    event.preventDefault(); event.stopPropagation(); closeAllMenus();
    let sp = globalStockpiles.find(s => s.id === id);
    if (sp) {
        sp.pinned = !sp.pinned;
        queueAction({ type: 'update', id: id });
    }
}

async function actionDelete(event, id) {
    event.preventDefault(); event.stopPropagation(); closeAllMenus();
    let conf = await customConfirm("Are you sure you want to remove this entry? This is not reversible.");
    if (!conf) return;
    
    globalStockpiles = globalStockpiles.filter(s => s.id !== id);
    delete globalInventories[id];
    queueAction({ type: 'delete', id: id });
}

async function actionRename(event, id) {
    event.preventDefault(); event.stopPropagation(); closeAllMenus();
    let sp = globalStockpiles.find(s => s.id === id);
    if(!sp) return;

    let newName = await customPrompt(`Rename stockpile '${sp.name}':`, sp.name);
    if (!newName || newName.trim() === "" || newName === sp.name) return;
    
    sp.name = newName.trim();
    queueAction({ type: 'update', id: id });
}

// ==========================================
// 7. INVENTORY & TARGETS MODAL
// ==========================================
function openInventory(id, name, type) {
    const mod = document.getElementById('invModal');
    mod.style.display = "flex"; 
    document.getElementById('modalTitle').innerText = name + " Contents";
    currentModalId = id;
    
    const inv = globalInventories[id] || [];
    let html = '';
    
    if (inv.length === 0) {
        html = "<em style='color:#64748b;'>This stockpile is completely empty and has no targets.</em>";
    } else {
        inv.forEach(item => {
            let qtyDisplay = `<span class="inv-qty">${item.qty}</span>`;
            if (parseInt(item.target) > 0) {
                qtyDisplay = `<div class="inv-qty target-text">
                    <span class="qty-current">${item.qty}</span> / 
                    <span class="qty-target">${item.target}</span>
                </div>`;
            }
            html += `<div class="inv-item">
                <span>${item.name}</span> 
                <div class="qty-box">
                    ${qtyDisplay}
                    <button class="btn-small" onclick="promptTarget('${id}', '${item.name}', '${item.target}')">Target</button>
                </div>
            </div>`;
        });
    }
    document.getElementById('modalBody').innerHTML = html;

    let selectHtml = `<option value="">-- Select Item to Track --</option>`;
    if (globalValidItems[type]) {
        Array.from(globalValidItems[type]).forEach(vItem => {
            selectHtml += `<option value="${vItem}">${vItem}</option>`;
        });
    }
    document.getElementById('newTargetSelect').innerHTML = selectHtml;
}

async function promptTarget(id, itemName, currentTarget) {
    let def = currentTarget && currentTarget !== "0" ? currentTarget : "";
    let newVal = await customPrompt(`Set target for ${itemName} (0 or empty to remove):`, def);
    if (newVal === null) return; 
    applyLocalTarget(id, itemName, newVal);
}

async function submitNewTarget() {
    let item = document.getElementById('newTargetSelect').value;
    if (!item) { showToast("Please select an item first.", "warning"); return; }
    let newVal = await customPrompt(`Set target for ${item}:`);
    if (newVal === null) return;
    applyLocalTarget(currentModalId, item, newVal);
}

function applyLocalTarget(id, itemName, targetValue) {
    targetValue = targetValue || "0";
    if (!globalInventories[id]) globalInventories[id] = [];
    
    let invItem = globalInventories[id].find(i => i.name === itemName);
    if (invItem) {
        invItem.target = targetValue;
    } else {
        globalInventories[id].push({ name: itemName, qty: "0", target: targetValue });
    }
    
    queueAction({ type: 'update', id: id });
}

// ==========================================
// 8. DASHBOARD RENDERING (TABLES & GOALS)
// ==========================================
function populateGoals() {
    const container = document.getElementById('goalsContainer');
    const section = document.getElementById('goalsSection');
    container.innerHTML = '';
    let hasGoals = false;

    globalStockpiles.forEach(sp => {
        if (!sp.pinned) return;
        const inv = globalInventories[sp.id] || [];
        const targetItems = inv.filter(i => parseInt(i.target) > 0);
        
        if (targetItems.length > 0) {
            hasGoals = true;
            let cardHtml = `<div class="goal-card"><h3><span style="color:#f59e0b; margin-right:5px;">📌</span> ${sp.name} <span style="font-size:12px; color:#64748b; margin-left:5px;">(${sp.poi})</span></h3>`;
            
            targetItems.forEach(item => {
                let q = parseInt(item.qty) || 0;
                let t = parseInt(item.target);
                let statusClass = q >= t ? 'goal-met' : 'goal-under';
                cardHtml += `<div class="goal-item">
                    <span>${item.name}</span>
                    <span class="goal-text ${statusClass}">${q} / ${t}</span>
                </div>`;
            });
            
            cardHtml += `</div>`;
            container.innerHTML += cardHtml;
        }
    });
    section.style.display = hasGoals ? 'block' : 'none';
}

function populateTable(data) {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding:30px; color:#64748b;">No stockpiles match the filters.</td></tr>';
        return;
    }

    data.forEach(sp => {
        let nameHtml = sp.name.toUpperCase() === 'PUBLIC' ? `<span class="public-badge">PUBLIC</span>` : sp.name;
        if (sp.pinned) nameHtml = `<span style="color:#f59e0b; font-size: 14px;">📌</span> ` + nameHtml;
        
        let dateObj = new Date(sp.last_modified);
        let dateStr = isNaN(dateObj) ? "Unknown" : dateObj.toLocaleString();

        let rowClass = sp.pinned ? "data-row pinned-row" : "data-row";

        let row = `<tr class="${rowClass}" onclick="openInventory('${sp.id}', '${sp.name}', '${sp.type}')">
            <td>${sp.hex}</td>
            <td>${sp.poi}</td>
            <td>${sp.type}</td>
            <td>${nameHtml}</td>
            <td>${dateStr}</td>
            <td onclick="event.stopPropagation();">
                <div class="dropdown">
                    <button class="dropbtn" onclick="toggleMenu(event, 'menu-${sp.id}')">⋮</button>
                    <div id="menu-${sp.id}" class="dropdown-content">
                        <a href="#" onclick="actionTogglePinned(event, '${sp.id}')">${sp.pinned ? 'Remove Pin' : 'Set as Pinned'}</a>
                        <a href="#" onclick="actionRename(event, '${sp.id}')">Rename Stockpile</a>
                        <a href="#" style="color:#dc2626; font-weight:bold;" onclick="actionDelete(event, '${sp.id}')">Delete Entry</a>
                    </div>
                </div>
            </td>
        </tr>`;
        tbody.innerHTML += row;
    });
}

function populateTypeDropdown() {
    const types = [...new Set(globalStockpiles.map(item => item.type))];
    const select = document.getElementById('searchType');
    
    const currentVal = select.value; 
    select.innerHTML = '<option value="">All Types</option>';
    types.forEach(t => { 
        let selected = (t === currentVal) ? "selected" : "";
        select.innerHTML += `<option value="${t}" ${selected}>${t}</option>`; 
    });
}

function applyFilters() {
    const hex = document.getElementById('searchHex').value.toLowerCase();
    const poi = document.getElementById('searchPOI').value.toLowerCase();
    const name = document.getElementById('searchName').value.toLowerCase();
    const type = document.getElementById('searchType').value;

    const filtered = globalStockpiles.filter(sp => {
        return sp.hex.toLowerCase().includes(hex) &&
               sp.poi.toLowerCase().includes(poi) &&
               sp.name.toLowerCase().includes(name) &&
               (type === "" || sp.type === type);
    });
    populateTable(filtered);
}

document.getElementById('searchHex').addEventListener('input', applyFilters);
document.getElementById('searchPOI').addEventListener('input', applyFilters);
document.getElementById('searchName').addEventListener('input', applyFilters);
document.getElementById('searchType').addEventListener('change', applyFilters);

function toggleMenu(event, menuId) {
    event.stopPropagation();
    closeAllMenus();
    document.getElementById(menuId).classList.toggle("show-menu");
}

function closeAllMenus() {
    var dropdowns = document.getElementsByClassName("dropdown-content");
    for (var i = 0; i < dropdowns.length; i++) dropdowns[i].classList.remove('show-menu');
}

// ==========================================
// 9. HELPER MODALS & TOASTS
// ==========================================
function showToast(message, type = "success") {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    
    let icon = '✅';
    if(type === 'error') icon = '❌';
    if(type === 'warning') icon = '⚠️';

    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span style="font-size:18px;">${icon}</span> <span>${message}</span>`;
    
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('hide');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function customPrompt(message, defaultValue = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('promptModal');
        document.getElementById('promptMessage').innerText = message;
        const input = document.getElementById('promptInput');
        input.value = defaultValue;
        modal.style.display = 'flex';
        input.focus();

        const confirmBtn = document.getElementById('promptConfirm');
        const cancelBtn = document.getElementById('promptCancel');

        const cleanup = () => { modal.style.display = 'none'; confirmBtn.onclick = null; cancelBtn.onclick = null; };
        confirmBtn.onclick = () => { resolve(input.value); cleanup(); };
        cancelBtn.onclick = () => { resolve(null); cleanup(); };
    });
}

function customConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('promptModal');
        document.getElementById('promptMessage').innerText = message;
        document.getElementById('promptInput').style.display = 'none';
        modal.style.display = 'flex';

        const confirmBtn = document.getElementById('promptConfirm');
        const cancelBtn = document.getElementById('promptCancel');
        
        confirmBtn.innerText = "Yes, Delete";
        confirmBtn.style.background = "#ef4444";

        const cleanup = () => { 
            modal.style.display = 'none'; 
            document.getElementById('promptInput').style.display = 'block'; 
            confirmBtn.innerText = "Confirm";
            confirmBtn.style.background = "#10b981";
            confirmBtn.onclick = null; cancelBtn.onclick = null; 
        };
        confirmBtn.onclick = () => { resolve(true); cleanup(); };
        cancelBtn.onclick = () => { resolve(false); cleanup(); };
    });
}
