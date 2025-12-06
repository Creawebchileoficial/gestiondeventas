import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js';
import { getFirestore, collection, query, where, getDocs, addDoc, updateDoc, deleteDoc, doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js';

const SHARED_SESSION_KEY = 'sellstream_shared_session';
const app = window.firebaseApp;
const auth = getAuth(app);
const db = getFirestore(app);

let sharedSession = null;
let currentProducts = [];
let productSearchTerm = '';
let productModalInstance = null;
let productUsageMap = {};

const productListElement = document.getElementById('productList');
const productSearchInput = document.getElementById('productSearch');
const exportProductsBtn = document.getElementById('exportProductsBtn');
const newProductBtn = document.getElementById('newProductBtn');
const productForm = document.getElementById('productForm');
const productModalElement = document.getElementById('productModal');
const productModalTitle = document.getElementById('productModalTitle');
const productSubmitBtn = document.getElementById('productSubmitBtn');
const productIdInput = document.getElementById('productId');
const inventoryView = document.getElementById('inventoryView');
const inventoryEmptyState = document.getElementById('inventoryEmptyState');
const inventoryUserEmail = document.getElementById('inventoryUserEmail');
const backToDashboardBtn = document.getElementById('backToDashboard');

restoreSharedSession();

if (productModalElement) {
    productModalInstance = new bootstrap.Modal(productModalElement);
    productModalElement.addEventListener('hidden.bs.modal', () => {
        resetProductForm();
    });
}

if (backToDashboardBtn) {
    backToDashboardBtn.addEventListener('click', () => {
        window.location.href = 'index.html';
    });
}

if (productSearchInput) {
    productSearchInput.addEventListener('input', (event) => {
        applyProductSearch(event.target.value);
    });
}

if (exportProductsBtn) {
    exportProductsBtn.addEventListener('click', () => {
        exportProductsToCSV();
    });
}

if (newProductBtn) {
    newProductBtn.addEventListener('click', () => {
        openProductModal();
    });
}

if (productForm) {
    productForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitBtn = productSubmitBtn || productForm.querySelector('button[type="submit"]');
        showLoading(submitBtn);

        try {
            const ownerId = getActiveUserId();
            if (!ownerId) {
                throw new Error('Inicia sesión para guardar productos');
            }

            const payload = collectProductFormData();
            if (!payload.name) {
                throw new Error('Ingresa un nombre para el producto');
            }

            const existingId = productIdInput?.value;

            if (existingId) {
                await updateDoc(doc(db, 'products', existingId), {
                    ...payload,
                    updatedAt: getChileDateTime()
                });
                showSuccess('Producto actualizado');
            } else {
                await addDoc(collection(db, 'products'), {
                    ...payload,
                    userId: ownerId,
                    createdAt: getChileDateTime(),
                    updatedAt: getChileDateTime()
                });
                showSuccess('Producto guardado');
            }

            productModalInstance?.hide();
            resetProductForm();
            loadProducts();
        } catch (error) {
            showError(error.message || 'Error al guardar el producto');
        } finally {
            hideLoading(submitBtn);
        }
    });
}

onAuthStateChanged(auth, async (user) => {
    if (user && sharedSession) {
        clearSharedSession();
    }
    await refreshInventoryView();
});

function restoreSharedSession() {
    try {
        const stored = localStorage.getItem(SHARED_SESSION_KEY);
        if (stored) {
            sharedSession = JSON.parse(stored);
        }
    } catch (error) {
        sharedSession = null;
    }
}

function persistSharedSession() {
    if (sharedSession) {
        localStorage.setItem(SHARED_SESSION_KEY, JSON.stringify(sharedSession));
    }
}

function clearSharedSession() {
    sharedSession = null;
    localStorage.removeItem(SHARED_SESSION_KEY);
}

function isSharedSessionActive() {
    return !!sharedSession;
}

function getActiveUserId() {
    if (isSharedSessionActive()) {
        return sharedSession.ownerId;
    }
    return auth.currentUser?.uid || null;
}

async function validateSharedAccessState() {
    if (!isSharedSessionActive()) {
        return true;
    }
    try {
        const accessRef = doc(db, 'sharedAccess', sharedSession.accessId);
        const snapshot = await getDoc(accessRef);
        if (!snapshot.exists()) {
            clearSharedSession();
            return false;
        }
        const data = snapshot.data();
        if (data.ownerId !== sharedSession.ownerId) {
            clearSharedSession();
            return false;
        }
        return true;
    } catch (error) {
        clearSharedSession();
        return false;
    }
}

async function loadProductUsage() {
    const ownerId = getActiveUserId();
    productUsageMap = {};

    if (!ownerId) {
        return;
    }

    try {
        const salesQuery = query(
            collection(db, 'sales'),
            where('userId', '==', ownerId)
        );
        const snapshot = await getDocs(salesQuery);
        snapshot.forEach(docSnap => {
            const sale = docSnap.data();
            if (sale.productId && sale.status === 'active') {
                productUsageMap[sale.productId] = (productUsageMap[sale.productId] || 0) + 1;
            }
        });
    } catch (error) {
        console.error('No se pudo calcular el uso de perfiles:', error);
        productUsageMap = {};
    }
}

async function refreshInventoryView() {
    const userId = getActiveUserId();
    const isSharedValid = await validateSharedAccessState();

    if (!isSharedValid) {
        await refreshInventoryView();
        return;
    }

    if (!userId) {
        toggleInventoryVisibility(false);
        updateInventoryStats([]);
        renderProducts([]);
        return;
    }

    toggleInventoryVisibility(true);
    updateUserBadge();
    await loadProductUsage();
    await loadProducts();
}

function toggleInventoryVisibility(showInventory) {
    if (inventoryView) {
        inventoryView.style.display = showInventory ? 'block' : 'none';
    }
    if (inventoryEmptyState) {
        inventoryEmptyState.style.display = showInventory ? 'none' : 'block';
    }
}

function updateUserBadge() {
    if (!inventoryUserEmail) return;
    if (isSharedSessionActive()) {
        inventoryUserEmail.innerHTML = `<i class="fas fa-users me-2"></i>Acceso compartido`;
    } else if (auth.currentUser?.email) {
        inventoryUserEmail.innerHTML = `<i class="fas fa-user me-2"></i>${auth.currentUser.email}`;
    } else {
        inventoryUserEmail.textContent = '';
    }
}

function showLoading(element) {
    if (!element) return;
    element.classList.add('loading');
    element.disabled = true;
}

function hideLoading(element) {
    if (!element) return;
    element.classList.remove('loading');
    element.disabled = false;
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast-notification ${type === 'error' ? 'bg-danger' : 'bg-success'}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showSuccess(message) {
    showToast(message, 'success');
}

function showError(message) {
    showToast(message, 'error');
}

function formatCLP(amount) {
    return new Intl.NumberFormat('es-CL', {
        style: 'currency',
        currency: 'CLP'
    }).format(amount || 0);
}

function getChileDateTime() {
    try {
        const now = new Date();
        const chileDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
        return chileDate.toISOString();
    } catch (error) {
        return new Date().toISOString();
    }
}

function resetProductForm() {
    if (!productForm) return;
    productForm.reset();
    if (productIdInput) productIdInput.value = '';
    if (productModalTitle) productModalTitle.textContent = 'Nuevo producto';
    if (productSubmitBtn) productSubmitBtn.textContent = 'Guardar producto';
}

function collectProductFormData() {
    const getValue = (id) => document.getElementById(id)?.value ?? '';
    const normalize = (value) => {
        const trimmed = (value || '').trim();
        return trimmed || null;
    };

    return {
        name: normalize(getValue('productTitle')) || '',
        sku: normalize(getValue('productSku')),
        stock: parseInt(getValue('productStock') || '0', 10) || 0,
        minStock: parseInt(getValue('productMinStock') || '0', 10) || 0,
        price: parseInt(getValue('productPrice') || '0', 10) || 0,
        profileSlots: parseInt(getValue('productProfileSlots') || '0', 10) || 0,
        licenseKey: normalize(getValue('productLicenseKey')),
        access: {
            username: normalize(getValue('productAccessUser')),
            password: normalize(getValue('productAccessPassword')),
            url: normalize(getValue('productAccessUrl'))
        },
        tags: (getValue('productTags') || '')
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean),
        notes: normalize(getValue('productNotes'))
    };
}

function openProductModal(product = null) {
    if (!productModalInstance) return;

    if (!product) {
        resetProductForm();
    } else {
        if (productIdInput) productIdInput.value = product.id;
        document.getElementById('productTitle').value = product.name || '';
        document.getElementById('productSku').value = product.sku || '';
        document.getElementById('productStock').value = product.stock ?? 0;
        document.getElementById('productMinStock').value = product.minStock ?? 0;
        document.getElementById('productPrice').value = product.price ?? 0;
        document.getElementById('productProfileSlots').value = product.profileSlots ?? 0;
        document.getElementById('productAccessUser').value = product.access?.username || '';
        document.getElementById('productAccessPassword').value = product.access?.password || '';
        document.getElementById('productAccessUrl').value = product.access?.url || '';
        document.getElementById('productLicenseKey').value = product.licenseKey || '';
        document.getElementById('productTags').value = (product.tags || []).join(', ');
        document.getElementById('productNotes').value = product.notes || '';
        if (productModalTitle) productModalTitle.textContent = 'Editar producto';
        if (productSubmitBtn) productSubmitBtn.textContent = 'Actualizar producto';
    }

    productModalInstance.show();
}

function productMatchesTerm(product, term) {
    if (!term) return true;
    const haystack = [
        product.name || '',
        product.sku || '',
        product.licenseKey || '',
        ...(product.tags || [])
    ].join(' ').toLowerCase();
    return haystack.includes(term);
}

function getFilteredProducts(term = productSearchTerm) {
    const normalized = (term || '').toLowerCase().trim();
    return currentProducts.filter(product => productMatchesTerm(product, normalized));
}

function getProductProfileUsage(product) {
    const profileSlots = Math.max(Number(product.profileSlots) || 0, 0);
    const autoUsed = Math.min(Math.max(productUsageMap[product.id] || 0, 0), profileSlots);
    const manualRequested = Math.max(Number(product.manualProfilesUsed) || 0, 0);
    const maxManual = Math.max(profileSlots - autoUsed, 0);
    const manualUsed = Math.min(manualRequested, maxManual);
    const totalUsed = Math.min(autoUsed + manualUsed, profileSlots);
    const free = Math.max(profileSlots - totalUsed, 0);
    return { profileSlots, autoUsed, manualUsed, manualRequested, totalUsed, free, maxManual };
}

function renderProducts(products) {
    if (!productListElement) return;

    if (!products.length) {
        productListElement.innerHTML = `
            <div class="col-12">
                <div class="inventory-empty text-center p-5">
                    <i class="fas fa-layer-group fa-3x text-muted mb-3"></i>
                    <h5 class="mb-1">Aún no guardas productos</h5>
                    <p class="text-muted mb-0">Registra claves y stock para evitar olvidos.</p>
                </div>
            </div>
        `;
        return;
    }

    productListElement.innerHTML = products.map(buildProductCard).join('');
}

function buildProductCard(product) {
    const stockValue = Number(product.stock ?? 0);
    const minStockValue = Number(product.minStock ?? 0);
    const lowStock = minStockValue > 0 && stockValue <= minStockValue;
    const profileUsage = getProductProfileUsage(product);
    const { profileSlots, totalUsed, free, autoUsed, manualUsed, manualRequested } = profileUsage;
    const tags = (product.tags || []).map(tag => `<span class="tag-chip">${tag}</span>`).join('');
    const accessBlock = buildProductCredentialBlock(product);
    const licenseBlock = product.licenseKey ? `
        <p class="product-meta mb-2">
            <i class="fas fa-barcode me-2"></i>Licencia:
            <span class="password-wrapper">
                <span class="password-dots">${'•'.repeat(product.licenseKey.length)}</span>
                <span class="password-text" style="display:none">${product.licenseKey}</span>
                <button type="button" class="btn btn-sm btn-outline-secondary ms-2" onclick="togglePasswordDisplay(this)">
                    <i class="fas fa-eye"></i>
                </button>
            </span>
        </p>
    ` : '';
    const profileBlock = profileSlots > 0 ? `
        <div class="product-meta mb-2 d-flex align-items-center flex-wrap gap-2">
            <span class="badge ${free === 0 ? 'bg-danger' : 'bg-success'}">
                Perfiles ${totalUsed}/${profileSlots}
            </span>
            <small class="text-muted">${free} disponibles</small>
        </div>
        ${(autoUsed || manualUsed) ? `
            <div class="d-flex gap-3 small text-muted flex-wrap mb-2">
                <span><i class="fas fa-sync me-1"></i>Ventas: ${autoUsed}</span>
                <span><i class="fas fa-hand-point-up me-1"></i>Manual: ${manualUsed}</span>
            </div>
        ` : ''}
        <div class="d-flex align-items-center gap-2 flex-wrap profile-manual-controls mb-2">
            <button class="btn btn-sm btn-outline-secondary" onclick="adjustManualProfileUsage('${product.id}', -1)" ${manualRequested <= 0 ? 'disabled' : ''} title="Liberar un perfil manual">
                <i class="fas fa-minus"></i>
            </button>
            <button class="btn btn-sm btn-outline-primary" onclick="adjustManualProfileUsage('${product.id}', 1)" ${free === 0 ? 'disabled' : ''} title="Marcar un perfil como vendido">
                <i class="fas fa-plus"></i>
            </button>
            <small class="text-muted">Ajustar cupos manuales</small>
        </div>
    ` : '';

    return `
        <div class="col-xl-3 col-lg-4 col-md-6">
            <div class="product-card ${lowStock ? 'low-stock' : ''}">
                <div class="d-flex justify-content-between align-items-start">
                    <div>
                        <h5 class="mb-1">${product.name || 'Sin nombre'}</h5>
                        ${product.sku ? `<small class="text-muted">SKU: ${product.sku}</small>` : ''}
                    </div>
                    <div class="text-end">
                        <span class="badge ${lowStock ? 'bg-danger' : 'bg-light text-dark'}">
                            ${stockValue} u.
                        </span>
                        ${lowStock ? '<small class="d-block text-danger">Reponer</small>' : ''}
                    </div>
                </div>
                <p class="product-meta mb-2">
                    <i class="fas fa-dollar-sign me-2"></i>${formatCLP(product.price || 0)}
                </p>
                ${profileBlock}
                ${licenseBlock}
                ${accessBlock}
                ${product.notes ? `<p class="small text-muted mb-2"><i class="fas fa-sticky-note me-2"></i>${product.notes}</p>` : ''}
                ${tags ? `<div>${tags}</div>` : ''}
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-secondary" onclick="copyProductInfo('${product.id}')">
                        <i class="fas fa-copy me-1"></i>Copiar
                    </button>
                    <button class="btn btn-sm btn-primary" onclick="editProduct('${product.id}')">
                        <i class="fas fa-edit me-1"></i>Editar
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteProduct('${product.id}')">
                        <i class="fas fa-trash me-1"></i>Eliminar
                    </button>
                </div>
            </div>
        </div>
    `;
}

function buildProductCredentialBlock(product) {
    const access = product.access || {};
    if (!access.username && !access.password && !access.url) {
        return '';
    }

    return `
        <div class="inventory-credential">
            ${access.username ? `<p class="mb-1 small"><i class="fas fa-user me-2"></i>${access.username}</p>` : ''}
            ${access.password ? `
                <p class="mb-1 small">
                    <i class="fas fa-key me-2"></i>
                    <span class="password-wrapper">
                        <span class="password-dots">${'•'.repeat(access.password.length)}</span>
                        <span class="password-text" style="display:none">${access.password}</span>
                        <button type="button" class="btn btn-sm btn-outline-secondary ms-2" onclick="togglePasswordDisplay(this)">
                            <i class="fas fa-eye"></i>
                        </button>
                    </span>
                </p>
            ` : ''}
            ${access.url ? `<p class="mb-0 small"><i class="fas fa-link me-2"></i><a href="${access.url}" target="_blank" class="text-decoration-none">${access.url}</a></p>` : ''}
        </div>
    `;
}

function updateInventoryStats(products) {
    const totals = products.reduce((acc, product) => {
        const stockValue = Number(product.stock) || 0;
        const minStockValue = Number(product.minStock) || 0;
        const usage = getProductProfileUsage(product);

        acc.units += stockValue;
        if (minStockValue > 0 && stockValue <= minStockValue) {
            acc.lowStock += 1;
        }
        acc.profilesUsed += usage.totalUsed;
        acc.profilesFree += usage.free;
        return acc;
    }, { units: 0, lowStock: 0, profilesUsed: 0, profilesFree: 0 });

    setInventoryStat('inventoryTotal', products.length);
    setInventoryStat('inventoryStock', totals.units);
    setInventoryStat('inventoryLowStock', totals.lowStock);
    setInventoryStat('inventoryProfilesUsed', totals.profilesUsed);
    setInventoryStat('inventoryProfilesFree', totals.profilesFree);
}

function setInventoryStat(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

async function loadProducts() {
    if (!productListElement) return;

    productListElement.innerHTML = `
        <div class="col-12 text-center">
            <div class="loading"></div>
        </div>
    `;

    try {
        const ownerId = getActiveUserId();
        if (!ownerId) {
            throw new Error('No hay usuario activo');
        }

        const productsQuery = query(
            collection(db, 'products'),
            where('userId', '==', ownerId)
        );

        const snapshot = await getDocs(productsQuery);
        currentProducts = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
        updateInventoryStats(currentProducts);
        renderProducts(getFilteredProducts());
    } catch (error) {
        console.error('Error al cargar productos:', error);
        productListElement.innerHTML = `
            <div class="col-12">
                <div class="alert alert-danger">Error al cargar productos: ${error.message}</div>
            </div>
        `;
        updateInventoryStats([]);
    }
}

function applyProductSearch(term = productSearchTerm) {
    if (!productListElement) return;
    productSearchTerm = (term || '').toLowerCase();
    renderProducts(getFilteredProducts(productSearchTerm));
}

function formatProductInfoForClipboard(product) {
    let info = `📦 ${product.name || 'Sin nombre'}\n`;
    if (product.sku) info += `SKU: ${product.sku}\n`;
    info += `Stock: ${product.stock ?? 0}\n`;
    info += `Precio: ${formatCLP(product.price || 0)}\n`;
    const usage = getProductProfileUsage(product);
    if (usage.profileSlots) {
        info += `Perfiles: ${usage.totalUsed}/${usage.profileSlots} (Disponibles: ${usage.free})`;
        if (usage.manualUsed) {
            info += ` · Manual: ${usage.manualUsed}`;
        }
        info += '\n';
    }
    if (product.licenseKey) info += `Clave: ${product.licenseKey}\n`;
    if (product.access?.username) info += `Usuario: ${product.access.username}\n`;
    if (product.access?.password) info += `Contraseña: ${product.access.password}\n`;
    if (product.access?.url) info += `Panel: ${product.access.url}\n`;
    if (product.notes) info += `Notas: ${product.notes}\n`;
    if (product.tags?.length) info += `Etiquetas: ${product.tags.join(', ')}\n`;
    return info;
}

function exportProductsToCSV() {
    if (!currentProducts.length) {
        showError('No hay productos para exportar');
        return;
    }

    const rows = [
        ['Producto', 'SKU', 'Stock', 'Stock mínimo', 'Precio CLP', 'Clave', 'Usuario', 'Contraseña', 'URL', 'Etiquetas', 'Notas']
    ];

    currentProducts.forEach(product => {
        rows.push([
            product.name || '',
            product.sku || '',
            product.stock ?? 0,
            product.minStock ?? 0,
            product.price ?? 0,
            product.licenseKey || '',
            product.access?.username || '',
            product.access?.password || '',
            product.access?.url || '',
            (product.tags || []).join(' '),
            product.notes || ''
        ]);
    });

    const csvContent = rows
        .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))
        .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sellstream_productos_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

function copyProductInfo(productId) {
    const product = currentProducts.find(item => item.id === productId);
    if (!product) return;

    navigator.clipboard.writeText(formatProductInfoForClipboard(product)).then(() => {
        showSuccess('Ficha copiada al portapapeles');
    }).catch(() => {
        showError('No se pudo copiar la ficha');
    });
}

async function editProduct(productId) {
    try {
        const productRef = doc(db, 'products', productId);
        const snapshot = await getDoc(productRef);
        if (!snapshot.exists()) {
            throw new Error('Producto no encontrado');
        }
        if (snapshot.data().userId !== getActiveUserId()) {
            throw new Error('No tienes permiso para editar este producto');
        }
        const productData = { id: productId, ...snapshot.data() };
        openProductModal(productData);
    } catch (error) {
        showError(error.message || 'No se pudo cargar el producto');
    }
}

async function deleteProduct(productId) {
    if (!confirm('¿Eliminar esta ficha de producto?')) return;

    try {
        const productRef = doc(db, 'products', productId);
        const snapshot = await getDoc(productRef);
        if (!snapshot.exists()) {
            throw new Error('Producto no encontrado');
        }

        if (snapshot.data().userId !== getActiveUserId()) {
            throw new Error('No tienes permiso para eliminar este producto');
        }

        await deleteDoc(productRef);
        showSuccess('Producto eliminado');
        loadProducts();
    } catch (error) {
        showError(error.message || 'No se pudo eliminar el producto');
    }
}

async function adjustManualProfileUsage(productId, delta) {
    const product = currentProducts.find(item => item.id === productId);
    if (!product) return;

    const usage = getProductProfileUsage(product);
    if (usage.profileSlots === 0) {
        showError('Configura primero los perfiles totales del producto');
        return;
    }

    const currentManual = Math.max(Number(product.manualProfilesUsed) || 0, 0);
    const desiredManual = currentManual + delta;
    const nextManual = Math.min(Math.max(desiredManual, 0), usage.maxManual);

    if (nextManual === currentManual) {
        if (delta > 0 && usage.free === 0) {
            showError('No quedan perfiles disponibles en este producto');
        }
        return;
    }

    try {
        await updateDoc(doc(db, 'products', productId), {
            manualProfilesUsed: nextManual,
            updatedAt: getChileDateTime()
        });
        showSuccess('Perfiles actualizados');
        await loadProducts();
    } catch (error) {
        console.error('Error ajustando perfiles manuales:', error);
        showError('No se pudo ajustar los perfiles');
    }
}

window.copyProductInfo = copyProductInfo;
window.editProduct = editProduct;
window.deleteProduct = deleteProduct;
window.adjustManualProfileUsage = adjustManualProfileUsage;
window.togglePasswordDisplay = function(button) {
    const wrapper = button.closest('.password-wrapper');
    const dots = wrapper.querySelector('.password-dots');
    const text = wrapper.querySelector('.password-text');
    const icon = button.querySelector('i');

    if (dots.style.display !== 'none') {
        dots.style.display = 'none';
        text.style.display = 'inline';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        dots.style.display = 'inline';
        text.style.display = 'none';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
};

window.togglePassword = function(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const button = event?.currentTarget;
    const icon = button?.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        if (icon) {
            icon.classList.remove('fa-eye');
            icon.classList.add('fa-eye-slash');
        }
    } else {
        input.type = 'password';
        if (icon) {
            icon.classList.remove('fa-eye-slash');
            icon.classList.add('fa-eye');
        }
    }
};
