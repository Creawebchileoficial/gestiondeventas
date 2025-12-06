import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, signOut, GoogleAuthProvider, signInWithPopup, fetchSignInMethodsForEmail } from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js';
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, updateDoc, getDoc, query, where, setDoc } from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js';

const app = window.firebaseApp;
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
const db = getFirestore(app);
const SHARED_SESSION_KEY = 'sellstream_shared_session';
const SHARED_EMAIL_DOMAIN = 'sellstream.trustzonestore.com';

let currentFilter = null;
let currentSales = [];
let sharedSession = null;
let sharedAccessEntries = [];
let inventoryProducts = [];
let productUsageMap = {};
let updateIntervals = new Map();

const sharedSessionBadge = document.getElementById('sharedSessionBadge');
const sharedAccessForm = document.getElementById('sharedAccessForm');
const sharedAccessAliasInput = document.getElementById('sharedAccessAlias');
const sharedAliasHelper = document.getElementById('sharedAliasHelper');
const sharedPasswordHelper = document.getElementById('sharedPasswordHelper');

let aliasCheckTimeout = null;
let lastAliasCheck = { alias: '', available: null };
const productHelperDefaults = new WeakMap();

function sanitizeAlias(value = '') {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9.-]/g, '')
        .replace(/\.+/g, '.')
        .replace(/^\./, '')
        .replace(/\.$/, '')
        .slice(0, 30);
}

function buildSharedEmail(alias) {
    const sanitized = sanitizeAlias(alias);
    return sanitized ? `${sanitized}@${SHARED_EMAIL_DOMAIN}` : '';
}

function normalizeEmail(value = '') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed.includes('@')) {
        return buildSharedEmail(trimmed);
    }
    const [alias, domain] = trimmed.split('@');
    if (domain === SHARED_EMAIL_DOMAIN) {
        return buildSharedEmail(alias);
    }
    return trimmed;
}

async function hashSharedPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function setAliasHelperState(message, state = 'muted') {
    if (!sharedAliasHelper) return;
    sharedAliasHelper.textContent = message;
    sharedAliasHelper.classList.remove('text-success', 'text-danger', 'text-muted');
    switch (state) {
        case 'success':
            sharedAliasHelper.classList.add('text-success');
            break;
        case 'danger':
            sharedAliasHelper.classList.add('text-danger');
            break;
        default:
            sharedAliasHelper.classList.add('text-muted');
    }
}

async function isAliasAvailable(alias) {
    const sanitized = sanitizeAlias(alias);
    if (!sanitized) return false;

    try {
        const aliasQuery = query(
            collection(db, 'sharedAccess'),
            where('email', '==', buildSharedEmail(sanitized))
        );
        const snapshot = await getDocs(aliasQuery);
        return snapshot.empty;
    } catch (error) {
        console.error('Error verificando alias:', error);
        return false;
    }
}

function persistSharedSession() {
    if (!sharedSession) {
        localStorage.removeItem(SHARED_SESSION_KEY);
        return;
    }
    localStorage.setItem(SHARED_SESSION_KEY, JSON.stringify(sharedSession));
}

function restoreSharedSession() {
    try {
        const stored = localStorage.getItem(SHARED_SESSION_KEY);
        if (stored) {
            sharedSession = JSON.parse(stored);
        }
    } catch (error) {
        console.warn('No se pudo restaurar el acceso compartido:', error);
        sharedSession = null;
    } finally {
        updateSharedSessionBadge();
    }
}

function clearSharedSession() {
    sharedSession = null;
    localStorage.removeItem(SHARED_SESSION_KEY);
    updateSharedSessionBadge();
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

function updateSharedSessionBadge() {
    if (!sharedSessionBadge) return;
    if (isSharedSessionActive()) {
        sharedSessionBadge.classList.remove('d-none');
        sharedSessionBadge.innerHTML = '<i class="fas fa-user-friends me-1"></i>Acceso compartido';
    } else {
        sharedSessionBadge.classList.add('d-none');
        sharedSessionBadge.innerHTML = '';
    }
}

restoreSharedSession();

if (sharedAccessAliasInput) {
    sharedAccessAliasInput.addEventListener('input', () => {
        const sanitized = sanitizeAlias(sharedAccessAliasInput.value);
        if (sharedAccessAliasInput.value !== sanitized) {
            sharedAccessAliasInput.value = sanitized;
        }
        if (!sanitized) {
            setAliasHelperState('Escribe un alias único; te mostraremos si está disponible.');
            lastAliasCheck = { alias: '', available: null };
            return;
        }

        const previewEmail = buildSharedEmail(sanitized);
        setAliasHelperState(`Verificando ${previewEmail}...`);
        lastAliasCheck = { alias: sanitized, available: null };
        if (aliasCheckTimeout) clearTimeout(aliasCheckTimeout);
        aliasCheckTimeout = setTimeout(async () => {
            const available = await isAliasAvailable(sanitized);
            lastAliasCheck = { alias: sanitized, available };
            if (available) {
                setAliasHelperState(`${previewEmail} está disponible`, 'success');
            } else {
                setAliasHelperState(`${previewEmail} ya existe. Intenta otro alias.`, 'danger');
            }
        }, 400);
    });
}

function isOwnerSessionActive() {
    return !!auth.currentUser && !isSharedSessionActive();
}

function logoutWorkspace() {
    clearSharedSession();
    if (auth.currentUser) {
        signOut(auth).catch((error) => {
            console.warn('Error al cerrar sesión:', error);
        });
    } else {
        refreshApplicationState(null);
    }
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
            showError('El acceso compartido fue revocado');
            return false;
        }
        const data = snapshot.data();
        if (data.ownerId !== sharedSession.ownerId) {
            clearSharedSession();
            return false;
        }
        return true;
    } catch (error) {
        console.error('Error validando acceso compartido:', error);
        clearSharedSession();
        showError('No se pudo validar el acceso compartido');
        return false;
    }
}

// Utility functions
function formatCLP(amount) {
    return new Intl.NumberFormat('es-CL', {
        style: 'currency',
        currency: 'CLP'
    }).format(amount);
}

function calculateDurationInDays(duration, periodType) {
    switch(periodType) {
        case 'days':
            return duration;
        case 'months':
            return duration * 30;
        case 'years':
            return duration * 365;
        default:
            return duration;
    }
}

function formatDuration(duration, periodType) {
    if (duration === 1) {
        return `1 ${periodType.slice(0, -1)}`;
    }
    return `${duration} ${periodType}`;
}

// Add timezone utilities
function getChileDateTime() {
    try {
        const now = new Date();
        const chileDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
        return chileDate.toISOString();
    } catch (error) {
        console.error('Error al obtener fecha Chile:', error);
        return new Date().toISOString(); // Fallback a fecha UTC
    }
}

// Modificar la función formatChileDate para manejar mejor las fechas ISO
function formatChileDate(date) {
    if (!date) return 'Fecha no disponible';
    
    try {
        // Intentar crear un nuevo objeto Date desde la entrada
        const dateObj = new Date(date);
        
        // Verificar si la fecha es válida
        if (isNaN(dateObj.getTime())) {
            return 'Fecha inválida';
        }
        
        return dateObj.toLocaleDateString('es-CL', {
            timeZone: 'America/Santiago',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    } catch (error) {
        console.error('Error al formatear fecha:', error);
        return 'Fecha inválida';
    }
}

// Add contact utilities
function formatWhatsAppLink(number, message) {
    const formattedMessage = encodeURIComponent(message);
    return `https://wa.me/56${number}?text=${formattedMessage}`;
}

function buildWhatsAppReminderMessage(sale) {
    const daysRemaining = calculateDaysRemaining(sale.startDate, sale.endDate);
    const clientName = sale.client || 'cliente';
    const productName = sale.product || 'tu servicio';

    if (daysRemaining < 0) {
        const daysExpired = Math.abs(daysRemaining);
        const expiredText = daysExpired === 1 ? '1 día' : `${daysExpired} días`;
        return `Hola ${clientName}, tu suscripción de ${productName} venció hace ${expiredText}. ¿Deseas renovarla para seguir disfrutando del servicio?`;
    }

    if (daysRemaining === 0) {
        return `Hola ${clientName}, tu suscripción de ${productName} vence hoy. Si quieres renovarla, avísame para activarla sin interrupciones.`;
    }

    return `Hola ${clientName}, te quedan ${daysRemaining} días de tu suscripción de ${productName}. ¿Quieres asegurar la renovación antes de que venza?`;
}

function formatContactInfo(sale) {
    let contactHtml = '';
    
    if (sale.whatsapp) {
        const message = buildWhatsAppReminderMessage(sale);
        contactHtml += `
            <p class="mb-1">
                <a href="${formatWhatsAppLink(sale.whatsapp, message)}" target="_blank" class="text-decoration-none">
                    <i class="fab fa-whatsapp me-2 text-success"></i>+56 ${sale.whatsapp}
                </a>
            </p>`;
    }
    
    if (sale.email) {
        contactHtml += `
            <p class="mb-1">
                <a href="mailto:${sale.email}" class="text-decoration-none">
                    <i class="fas fa-envelope me-2 text-primary"></i>${sale.email}
                </a>
            </p>`;
    }
    
    if (sale.instagram) {
        contactHtml += `
            <p class="mb-1">
                <a href="https://instagram.com/${sale.instagram}" target="_blank" class="text-decoration-none">
                    <i class="fab fa-instagram me-2 text-danger"></i>@${sale.instagram}
                </a>
            </p>`;
    }
    
    if (sale.facebook) {
        contactHtml += `
            <p class="mb-1">
                <a href="${sale.facebook.startsWith('http') ? sale.facebook : 'https://facebook.com/' + sale.facebook}" 
                   target="_blank" class="text-decoration-none">
                    <i class="fab fa-facebook me-2 text-primary"></i>${sale.facebook}
                </a>
            </p>`;
    }
    
    return contactHtml;
}

// Add function to format full sale info for sharing
function formatSaleInfoForSharing(sale) {
    const daysRemaining = calculateDaysRemaining(sale.startDate, sale.endDate);
    let info = `📦 ${sale.product}\n`;
    info += `💰 Precio: ${formatCLP(sale.price)}\n`;
    info += `📅 Inicio: ${formatChileDate(sale.startDate)}\n`;
    info += `🔚 Vence: ${formatChileDate(sale.endDate)}\n`;
    info += `⏳ ${daysRemaining > 0 ? `Quedan ${daysRemaining} días` : 'Vencido'}\n\n`;
    
    if (sale.accountCredentials) {
        info += "🔐 Datos de Acceso:\n";
        if (sale.accountCredentials.username) info += `👤 Usuario: ${sale.accountCredentials.username}\n`;
        if (sale.accountCredentials.password) info += `🔑 Contraseña: ${sale.accountCredentials.password}\n`;
        if (sale.accountCredentials.profile) info += `👥 Perfil: ${sale.accountCredentials.profile}\n`;
        if (sale.accountCredentials.pin) info += `📌 PIN: ${sale.accountCredentials.pin}\n`;
    }
    
    if (sale.notes) info += `\n📝 Notas: ${sale.notes}`;
    
    return info;
}





const authFormContainer = document.querySelector('.auth-form-container');
const authTabs = document.querySelectorAll('.auth-tab');
const loginForm = document.getElementById('authForm');
const registerForm = document.getElementById('registerForm');
const recoveryForm = document.getElementById('recoveryForm');
const collaboratorLoginForm = document.getElementById('collaboratorLoginForm');
const collaboratorAliasInput = document.getElementById('collaboratorAlias');
const collaboratorPasswordInput = document.getElementById('collaboratorPassword');
const openCollaboratorLoginBtn = document.getElementById('openCollaboratorLogin');
const backToOwnerAuthBtn = document.getElementById('backToOwnerAuth');
const saleProductSelect = document.getElementById('saleProductId');
const saleProductInfo = document.getElementById('saleProductInfo');
const saleProductProfileInput = document.getElementById('saleProductProfile');
const editSaleProductSelect = document.getElementById('editSaleProductId');
const editSaleProductInfo = document.getElementById('editSaleProductInfo');
const editSaleProductProfileInput = document.getElementById('editSaleProductProfile');

function setAuthView(view = 'login') {
    if (!authFormContainer) return;
    const showRegister = view === 'register';
    authFormContainer.classList.toggle('show-register', showRegister);
    authFormContainer.classList.remove('collaborator-mode');
    authTabs.forEach(tab => {
        const tabView = tab.dataset?.view;
        tab.classList.toggle('active', tabView === view);
    });

    if (loginForm && registerForm) {
        loginForm.classList.toggle('active', !showRegister);
        registerForm.classList.toggle('active', showRegister);
    }

    if (recoveryForm) {
        recoveryForm.classList.remove('active');
    }

    if (collaboratorLoginForm) {
        collaboratorLoginForm.classList.remove('active');
    }
}

function showCollaboratorLogin() {
    if (!collaboratorLoginForm) return;
    loginForm?.classList.remove('active');
    registerForm?.classList.remove('active');
    recoveryForm?.classList.remove('active');
    authTabs.forEach(tab => tab.classList.remove('active'));
    authFormContainer?.classList.add('collaborator-mode');
    collaboratorLoginForm.classList.add('active');
    if (collaboratorAliasInput) {
        collaboratorAliasInput.focus();
    }
}

function hideCollaboratorLogin() {
    if (!collaboratorLoginForm) return;
    collaboratorLoginForm.reset();
    collaboratorLoginForm.classList.remove('active');
    authFormContainer?.classList.remove('collaborator-mode');
    setAuthView('login');
}

// Auth form toggling
document.getElementById('showRegisterForm').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthView('register');
});

document.getElementById('showLoginForm').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthView('login');
});

const authTabLogin = document.getElementById('authTabLogin');
const authTabRegister = document.getElementById('authTabRegister');

if (authTabLogin) {
    authTabLogin.addEventListener('click', () => setAuthView('login'));
}

if (authTabRegister) {
    authTabRegister.addEventListener('click', () => setAuthView('register'));
}

setAuthView('login');

// Password recovery toggle
document.getElementById('forgotPasswordLink').addEventListener('click', (e) => {
    e.preventDefault();
    if (loginForm) loginForm.classList.remove('active');
    if (registerForm) registerForm.classList.remove('active');
    if (recoveryForm) recoveryForm.classList.add('active');
});

document.getElementById('backToLogin').addEventListener('click', (e) => {
    e.preventDefault();
    if (recoveryForm) recoveryForm.classList.remove('active');
    setAuthView('login');
});

if (openCollaboratorLoginBtn) {
    openCollaboratorLoginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        showCollaboratorLogin();
    });
}

if (backToOwnerAuthBtn) {
    backToOwnerAuthBtn.addEventListener('click', (e) => {
        e.preventDefault();
        hideCollaboratorLogin();
    });
}

if (collaboratorAliasInput) {
    collaboratorAliasInput.addEventListener('input', () => {
        const sanitized = sanitizeAlias(collaboratorAliasInput.value);
        if (collaboratorAliasInput.value !== sanitized) {
            collaboratorAliasInput.value = sanitized;
        }
    });
}

if (collaboratorLoginForm) {
    collaboratorLoginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = collaboratorLoginForm.querySelector('button[type="submit"]');
        showLoading(submitBtn);

        try {
            const sanitizedAlias = sanitizeAlias(collaboratorAliasInput?.value || '');
            const password = collaboratorPasswordInput?.value || '';

            if (!sanitizedAlias || sanitizedAlias.length < 3) {
                throw new Error('Ingresa un alias válido');
            }

            if (!password) {
                throw new Error('Ingresa la contraseña temporal');
            }

            if (collaboratorAliasInput && collaboratorAliasInput.value !== sanitizedAlias) {
                collaboratorAliasInput.value = sanitizedAlias;
            }

            const email = buildSharedEmail(sanitizedAlias);
            const success = await attemptSharedAccessLogin(email, password);
            if (!success) {
                throw new Error('Alias o contraseña incorrectos');
            }

            hideCollaboratorLogin();
        } catch (error) {
            showError(error.message || 'No se pudo validar el acceso');
        } finally {
            hideLoading(submitBtn);
        }
    });
}

// Update auth form submissions
document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    showLoading(submitBtn);
    
    try {
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        if (!email || !password) {
            throw new Error('Por favor ingresa email y contraseña');
        }

        await signInWithEmailAndPassword(auth, email, password);
        clearSharedSession();
        showSuccess('Inicio de sesión exitoso');
    } catch (error) {
        let errorMessage = '';
        switch (error.code) {
            case 'auth/user-not-found':
                if (await attemptSharedAccessLogin(document.getElementById('loginEmail').value, document.getElementById('loginPassword').value)) {
                    return;
                }
                errorMessage = 'Usuario no encontrado';
                break;
            case 'auth/wrong-password':
            case 'auth/invalid-credential':
                errorMessage = 'Contraseña incorrecta';
                break;
            case 'auth/invalid-email':
                errorMessage = 'Email inválido';
                break;
            case 'auth/too-many-requests':
                errorMessage = 'Demasiados intentos fallidos. Por favor, inténtalo más tarde';
                break;
            default:
                errorMessage = 'Error al iniciar sesión. Por favor, inténtalo de nuevo';
        }
        showError(errorMessage);
    } finally {
        hideLoading(submitBtn);
    }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    showLoading(submitBtn);
    
    const email = document.getElementById('registerEmail').value;
    const password = document.getElementById('registerPassword').value;
    const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
    
    if (password !== passwordConfirm) {
        showError('Las contraseñas no coinciden');
        hideLoading(submitBtn);
        return;
    }
    
    try {
        await createUserWithEmailAndPassword(auth, email, password);
        showSuccess('Cuenta creada exitosamente');
    } catch (error) {
        showError('Error de registro: ' + error.message);
    } finally {
        hideLoading(submitBtn);
    }
});

document.getElementById('googleLoginBtn').addEventListener('click', (e) => {
    handleGoogleAuth(e.currentTarget, 'login');
});

document.getElementById('googleRegisterBtn').addEventListener('click', (e) => {
    handleGoogleAuth(e.currentTarget, 'register');
});

document.getElementById('recoveryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    showLoading(submitBtn);
    
    try {
        const email = document.getElementById('recoveryEmail').value;
        await sendPasswordResetEmail(auth, email);
        showSuccess('Se ha enviado un enlace de recuperación a tu email');
        if (recoveryForm) recoveryForm.classList.remove('active');
        setAuthView('login');
    } catch (error) {
        showError('Error al enviar email de recuperación: ' + error.message);
    } finally {
        hideLoading(submitBtn);
    }
});

// Utility functions for notifications
function showError(message) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification bg-danger';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showSuccess(message) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification bg-success';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showLoading(button) {
    if (!button) return;
    if (!button.dataset.originalContent) {
        button.dataset.originalContent = button.innerHTML;
    }
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Procesando...';
}

function hideLoading(button) {
    if (!button) return;
    button.disabled = false;
    if (button.dataset.originalContent) {
        button.innerHTML = button.dataset.originalContent;
        delete button.dataset.originalContent;
    }
}

async function handleGoogleAuth(button, context = 'login') {
    if (!button) {
        console.warn('Google auth triggered without button element');
    }

    try {
        if (button) {
            showLoading(button);
        }

        const result = await signInWithPopup(auth, googleProvider);
        const user = result.user;

        await setDoc(doc(db, 'users', user.uid), {
            email: user.email,
            name: user.displayName || '',
            photoURL: user.photoURL || null,
            provider: 'google',
            updatedAt: getChileDateTime()
        }, { merge: true });

        clearSharedSession();
        const successMessage = context === 'register'
            ? 'Registro con Google exitoso'
            : 'Inicio de sesión con Google exitoso';
        showSuccess(successMessage);
    } catch (error) {
        let errorMessage = 'No se pudo conectar con Google. Inténtalo nuevamente';

        switch (error.code) {
            case 'auth/popup-closed-by-user':
                errorMessage = 'La ventana de Google se cerró antes de finalizar';
                break;
            case 'auth/cancelled-popup-request':
                errorMessage = 'Ya hay otro proceso de autenticación en curso';
                break;
            case 'auth/account-exists-with-different-credential':
                errorMessage = 'Ya existe una cuenta con otro método de acceso. Usa tu correo y contraseña.';
                break;
            case 'auth/unauthorized-domain': {
                const currentDomain = window?.location?.hostname || 'este dominio';
                errorMessage = `El dominio ${currentDomain} no está autorizado para usar Google Sign-In. Agrega este dominio en Firebase > Authentication > Settings > Authorized domains o usa la app oficial.`;
                break;
            }
            default:
                break;
        }

        showError(errorMessage);
        console.error('Google Auth error:', error);
    } finally {
        if (button) {
            hideLoading(button);
        }
    }
}

async function attemptSharedAccessLogin(email, password) {
    try {
        const normalizedEmail = normalizeEmail(email);
        const passwordHash = await hashSharedPassword(password);
        const accessQuery = query(
            collection(db, 'sharedAccess'),
            where('email', '==', normalizedEmail)
        );
        const snapshot = await getDocs(accessQuery);
        if (snapshot.empty) {
            return false;
        }

        let matchedEntry = null;
        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            if (!matchedEntry && data.passwordHash === passwordHash) {
                matchedEntry = { id: docSnap.id, ...data };
            }
        });

        if (!matchedEntry) {
            return false;
        }

        sharedSession = {
            ownerId: matchedEntry.ownerId,
            accessId: matchedEntry.id,
            email: normalizedEmail,
            ownerEmail: matchedEntry.ownerEmail || null,
            createdAt: matchedEntry.createdAt
        };
        persistSharedSession();
        updateSharedSessionBadge();
        showSuccess('Acceso compartido habilitado');
        await refreshApplicationState(auth.currentUser);
        return true;
    } catch (error) {
        console.error('Error al validar acceso compartido:', error);
        showError('No se pudo validar el acceso compartido');
        return false;
    }
}

// Eliminar este listener duplicado ya que tenemos uno más arriba que hace lo mismo
// document.getElementById('authForm').addEventListener('submit', async (e) => {
//     e.preventDefault();
//     const submitBtn = e.target.querySelector('button[type="submit"]');
//     showLoading(submitBtn);
//     const email = document.getElementById('email').value;
//     const password = document.getElementById('password').value;
    
//     try {
//         await signInWithEmailAndPassword(auth, email, password);
//     } catch (error) {
//         alert('Error: ' + error.message);
//     } finally {
//         hideLoading(submitBtn);
//     }
// });

// Eliminar este evento ya que ahora usamos el nuevo sistema de autenticación
// document.getElementById('registerBtn').addEventListener('click', async () => {
//     // ...remove this event listener...
// });

document.getElementById('logoutBtn').addEventListener('click', () => {
    logoutWorkspace();
});

// Sales functionality
document.getElementById('saleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const duration = parseInt(document.getElementById('duration').value);
    const periodType = document.getElementById('periodType').value;
    const durationInDays = calculateDurationInDays(duration, periodType);
    const startDate = new Date(document.getElementById('startDate').value);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + durationInDays);
    const linkedProductId = saleProductSelect?.value || '';
    const linkedProfile = (saleProductProfileInput?.value || '').trim();

    const sale = {
        product: document.getElementById('productName').value,
        client: document.getElementById('clientName').value,
        price: parseInt(document.getElementById('price').value),
        duration: durationInDays,
        periodType: periodType,
        originalDuration: duration,
        notes: document.getElementById('notes').value || '',
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        status: document.getElementById('saleStatus').value,
        userId: getActiveUserId(),
        createdAt: getChileDateTime(), // Fecha real de creación del registro
        whatsapp: document.getElementById('whatsapp').value,
        email: document.getElementById('email').value,
        instagram: document.getElementById('instagram').value,
        facebook: document.getElementById('facebook').value,
        accountCredentials: {
            username: document.getElementById('accountUser').value || null,
            password: document.getElementById('accountPassword').value || null,
            profile: document.getElementById('accountProfile').value || null,
            pin: document.getElementById('profilePin').value || null
        },
        productId: linkedProductId || null,
        productProfile: linkedProfile || null
    };

    try {
        await addDoc(collection(db, 'sales'), sale);
        const modal = bootstrap.Modal.getInstance(document.getElementById('saleModal'));
        modal.hide();
        loadSales();
    } catch (error) {
        alert('Error al guardar: ' + error.message);
    }
});

// Update calculateDaysRemaining function for more accurate calculations
function calculateDaysRemaining(startDate, endDate) {
    try {
        const now = new Date();
        const end = new Date(endDate);
        
        // Asegurarse de trabajar con fechas UTC para evitar problemas de zona horaria
        const nowUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
        const endUTC = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
        
        // Calcular la diferencia en días
        const diffTime = endUTC - nowUTC;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        return diffDays;
    } catch (error) {
        console.error('Error calculando días restantes:', error);
        return 0;
    }
}

function getStatusInfo(daysRemaining, status, sale) {
    if (status === 'completed') {
        return {
            class: 'bg-secondary',
            text: 'Completada',
            isActive: false,
            isCompleted: true
        };
    }

    if (daysRemaining < 0) {
        return {
            class: 'days-red',
            text: 'Vencido',
            isActive: false,
            isExpired: true
        };
    }

    if (daysRemaining === 0) {
        return {
            class: 'days-orange',
            text: 'Vence hoy',
            isActive: true,
            isExpiringToday: true
        };
    }

    // Calcular el porcentaje de tiempo transcurrido
    const elapsedPercentage = calculateElapsedPercentage(sale);

    if (elapsedPercentage >= 50) {
        return {
            class: 'days-orange',
            text: `Por vencer (${daysRemaining} días)`,
            isActive: true,
            isNearExpiry: true,
            elapsedPercentage
        };
    }

    return {
        class: 'days-green',
        text: `Próximo a vencer (${daysRemaining} días)`,
        isActive: true,
        elapsedPercentage
    };
}

// Add function to calculate elapsed time percentage
function calculateElapsedPercentage(sale) {
    try {
        const start = new Date(sale.startDate);
        const end = new Date(sale.endDate);
        const now = new Date(getChileDateTime());
        
        const totalDuration = end - start;
        const elapsed = now - start;
        
        return (elapsed / totalDuration) * 100;
    } catch (error) {
        console.error('Error calculando porcentaje transcurrido:', error);
        return 0;
    }
}

// Add function to check if sale is expired
function isSaleExpired(endDate) {
    const now = getChileDateTime();
    const end = new Date(endDate);
    return now > end;
}

// Modificar la función loadSales para garantizar el aislamiento de datos
async function loadSales() {
    // Resetear estadísticas al inicio
    updateDashboardStats({
        active: 0,
        nearExpiry: 0,
        expiringToday: 0,
        expired: 0,
        totalAmount: 0
    });

    const salesList = document.getElementById('salesList');
    salesList.innerHTML = '<div class="col-12 text-center"><div class="loading"></div></div>';
    
    try {
        const ownerId = getActiveUserId();
        if (!ownerId) {
            throw new Error('No hay espacio de trabajo activo');
        }

        // Crear query explícitamente filtrado por userId
        const salesQuery = query(
            collection(db, 'sales'),
            where('userId', '==', ownerId)
        );
        
        // Limpiar el array de ventas actuales
        currentSales = [];
        
        const querySnapshot = await getDocs(salesQuery);
        
        if (querySnapshot.empty) {
            salesList.innerHTML = `
                <div class="col-12 text-center">
                    <div class="p-5">
                        <i class="fas fa-box-open fa-3x mb-3 text-muted"></i>
                        <h4 class="text-muted">No hay ventas registradas</h4>
                        <p class="text-muted">Comienza creando una nueva suscripción</p>
                    </div>
                </div>
            `;
            return;
        }

        querySnapshot.forEach((doc) => {
            const sale = {...doc.data(), id: doc.id};
            if (sale.userId === ownerId) {
                currentSales.push(sale);
            }
        });
        
        applyFiltersAndSort();
        
    } catch (error) {
        console.error("Error loading sales:", error);
        salesList.innerHTML = `
            <div class="col-12 text-center">
                <div class="alert alert-danger">
                    Error al cargar las ventas: ${error.message}
                </div>
            </div>
        `;
    }
}

async function loadProducts() {
    const ownerId = getActiveUserId();
    if (!ownerId) {
        inventoryProducts = [];
        populateSaleProductOptions();
        return;
    }

    try {
        const productsQuery = query(
            collection(db, 'products'),
            where('userId', '==', ownerId)
        );
        const snapshot = await getDocs(productsQuery);
        inventoryProducts = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    } catch (error) {
        console.error('Error al cargar productos de inventario:', error);
        inventoryProducts = [];
    }

    populateSaleProductOptions();
}

function populateSaleProductOptions() {
    const selects = [
        { select: saleProductSelect, helper: saleProductInfo },
        { select: editSaleProductSelect, helper: editSaleProductInfo }
    ];

    const options = ['<option value="">Sin vincular con inventario</option>'];
    inventoryProducts.forEach(product => {
        const profileSlots = Number(product.profileSlots) || 0;
        const label = profileSlots ? `${product.name} (${profileSlots} perfiles)` : product.name;
        options.push(`<option value="${product.id}">${label}</option>`);
    });

    selects.forEach(({ select }) => {
        if (!select) return;
        const previousValue = select.value;
        select.innerHTML = options.join('');
        if (previousValue && inventoryProducts.some(product => product.id === previousValue)) {
            select.value = previousValue;
        }
    });

    selects.forEach(({ select, helper }) => bindProductHelper(select, helper));
}

function bindProductHelper(select, helper) {
    if (!select || !helper) return;

    if (!productHelperDefaults.has(helper)) {
        productHelperDefaults.set(helper, helper.textContent || '');
    }

    const updateHelper = () => {
        const product = inventoryProducts.find(item => item.id === select.value);
        if (product) {
            const profileSlots = Number(product.profileSlots) || 0;
            helper.textContent = profileSlots > 0
                ? `${profileSlots} perfiles totales. Usa el campo de perfil asignado para registrar qué cupo ocupaste.`
                : 'Este producto no tiene perfiles configurados. Ajusta sus cupos desde Inventario.';
        } else {
            helper.textContent = productHelperDefaults.get(helper) || '';
        }
    };

    if (!select.dataset.helperBound) {
        select.addEventListener('change', updateHelper);
        select.dataset.helperBound = 'true';
    }

    updateHelper();
}

// Función para renderizar las ventas filtradas
function renderSales(sales) {
    const salesList = document.getElementById('salesList');
    
    if (sales.length === 0) {
        salesList.innerHTML = `
            <div class="col-12 text-center">
                <div class="p-5">
                    <i class="fas fa-filter fa-3x mb-3 text-muted"></i>
                    <h4 class="text-muted">No se encontraron resultados</h4>
                </div>
            </div>
        `;
        return;
    }
    
    salesList.innerHTML = '';
    let stats = { active: 0, nearExpiry: 0, expiringToday: 0, expired: 0, totalAmount: 0 };
    
    sales.forEach(sale => {
        const daysRemaining = calculateDaysRemaining(sale.startDate, sale.endDate);
        const elapsedPercentage = calculateElapsedPercentage(sale);
        
        if (sale.status !== 'completed') {
            if (daysRemaining < 0) {
                stats.expired++;
            } else if (daysRemaining === 0) {
                stats.expiringToday++;
            } else if (elapsedPercentage >= 50) {
                stats.nearExpiry++;
            } else {
                stats.active++;
            }
        }
        
        stats.totalAmount += sale.price;

        const status = getStatusInfo(daysRemaining, sale.status, sale);
        const isExpired = isSaleExpired(sale.endDate);

        // Add progress bar to show elapsed time
        const progressBar = `
            <div class="progress mb-2" style="height: 4px;">
                <div class="progress-bar ${status.class}" 
                     role="progressbar" 
                     style="width: ${status.elapsedPercentage}%"
                     aria-valuenow="${status.elapsedPercentage}" 
                     aria-valuemin="0" 
                     aria-valuemax="100">
                </div>
            </div>
        `;

        // Update sale card HTML
        salesList.innerHTML += `
            <div class="col-md-4 col-sm-6">
                <div class="sale-card ${sale.status === 'completed' ? 'completed-sale' : ''}"
                     data-status="${status.isExpired ? 'expired' : status.isNearExpiry ? 'near-expiry' : 'active'}"
                     data-sale-id="${sale.id}">
                    <div class="card-body">
                        ${progressBar}
                        <div class="d-flex justify-content-between align-items-start mb-3">
                            <h5 class="card-title fw-bold mb-0">${sale.product}</h5>
                            <div>
                                <span class="days-remaining ${status.class}">
                                    ${status.text}
                                </span>
                            </div>
                        </div>
                        <div class="mb-3">
                            <p class="mb-1"><i class="fas fa-user me-2"></i>${sale.client}</p>
                            <p class="mb-1"><i class="fas fa-dollar-sign me-2"></i>${formatCLP(sale.price)}</p>
                            <p class="mb-1"><i class="fas fa-clock me-2"></i>${formatDuration(sale.originalDuration, sale.periodType)}</p>
                            <p class="mb-1"><i class="fas fa-calendar me-2"></i>Inicio: ${formatChileDate(sale.startDate)}</p>
                            <p class="mb-1"><i class="fas fa-calendar-check me-2"></i>Vence: ${formatChileDate(sale.endDate)}</p>
                            ${formatContactInfo(sale)}
                            ${formatAccountInfo(sale)}
                            ${sale.notes ? `<p class="mb-1 text-muted"><i class="fas fa-sticky-note me-2"></i>${sale.notes}</p>` : ''}
                            <p class="mb-1 text-muted">
                                <small>
                                    <i class="fas fa-info-circle me-2"></i>
                                    Registrado: ${formatChileDate(sale.createdAt)}
                                    ${sale.renewedAt ? `<br><i class="fas fa-sync me-2"></i>Renovado: ${formatChileDate(sale.renewedAt)}` : ''}
                                </small>
                            </p>
                        </div>
                        <div class="d-flex gap-2">
                            ${!status.isCompleted ? `
                                <button onclick="editSale('${sale.id}')" class="btn btn-sm btn-primary">
                                    <i class="fas fa-edit me-2"></i>Editar
                                </button>
                                ${isExpired ? `
                                    <button onclick="renewSale('${sale.id}')" class="btn btn-sm btn-success">
                                        <i class="fas fa-sync me-2"></i>Renovar
                                    </button>
                                ` : ''}
                            ` : ''}
                            <button onclick="toggleStatus('${sale.id}', '${sale.status}')" class="btn btn-sm btn-secondary">
                                <i class="fas fa-exchange-alt me-2"></i>${sale.status === 'completed' ? 'Reactivar' : 'Completar'}
                            </button>
                            <button onclick="deleteSale('${sale.id}')" class="btn btn-danger btn-sm">
                                <i class="fas fa-trash me-2"></i>Eliminar
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    });
    
    updateDashboardStats(stats);
    startAutoUpdates(sales);
}

// Add function to handle filters
async function loadFilters() {
    try {
        const ownerId = getActiveUserId();
        if (!ownerId) return;

        const filtersQuery = query(
            collection(db, 'filters'),
            where('userId', '==', ownerId)
        );
        
        const snapshot = await getDocs(filtersQuery);
        const filtersList = document.getElementById('filtersList');
        
        // Mantener los elementos fijos
        filtersList.innerHTML = `
            <li><a class="dropdown-item" href="#" onclick="clearFilters()">Mostrar todo</a></li>
            <li><hr class="dropdown-divider"></li>
        `;
        
        snapshot.forEach(doc => {
            const filter = doc.data();
            filtersList.innerHTML += `
                <li>
                    <div class="dropdown-item d-flex align-items-center justify-content-between">
                        <a href="#" onclick="applyFilter('${doc.id}')" class="text-decoration-none text-dark flex-grow-1">
                            ${filter.name}
                        </a>
                        <button class="btn btn-sm btn-link text-danger" onclick="deleteFilter('${doc.id}')">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                </li>
            `;
        });
    } catch (error) {
        console.error('Error loading filters:', error);
    }
}

// Agregar manejo del formulario de filtros
document.getElementById('filterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    try {
        const ownerId = getActiveUserId();
        if (!ownerId) {
            throw new Error('No hay usuario activo');
        }

        const filterData = {
            name: document.getElementById('filterName').value,
            keywords: document.getElementById('filterKeywords').value
                .split(',')
                .map(k => k.trim().toLowerCase())
                .filter(k => k),
            userId: ownerId,
            createdAt: getChileDateTime()
        };
        
        await addDoc(collection(db, 'filters'), filterData);
        
        // Limpiar y cerrar el modal
        e.target.reset();
        bootstrap.Modal.getInstance(document.getElementById('filterModal')).hide();
        
        // Recargar filtros
        loadFilters();
        showSuccess('Filtro creado exitosamente');
    } catch (error) {
        showError('Error al crear filtro: ' + error.message);
    }
});

// Funciones para el manejo de filtros
window.clearFilters = function() {
    currentFilter = null;
    applyFiltersAndSort();
};

window.applyFilter = async function(filterId) {
    try {
        const filterDoc = await getDoc(doc(db, 'filters', filterId));
        currentFilter = { id: filterId, ...filterDoc.data() };
        applyFiltersAndSort();
    } catch (error) {
        showError('Error al aplicar filtro: ' + error.message);
    }
};

if (sharedAccessForm) {
    sharedAccessForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!isOwnerSessionActive()) {
            showError('Solo el propietario puede crear accesos compartidos');
            return;
        }

        const submitBtn = sharedAccessForm.querySelector('button[type="submit"]');
        showLoading(submitBtn);

        try {
            const ownerId = auth.currentUser?.uid;
            if (!ownerId) {
                throw new Error('Debes iniciar sesión con tu cuenta principal');
            }

            const aliasInputValue = sharedAccessAliasInput?.value || '';
            const alias = sanitizeAlias(aliasInputValue);
            if (!alias || alias.length < 3) {
                throw new Error('El alias debe tener al menos 3 caracteres válidos');
            }
            if (sharedAccessAliasInput && sharedAccessAliasInput.value !== alias) {
                sharedAccessAliasInput.value = alias;
            }
            const email = buildSharedEmail(alias);
            const password = document.getElementById('sharedAccessPassword').value.trim();

            if (!email || !password) {
                throw new Error('Completa todos los campos');
            }

            let aliasAvailable = lastAliasCheck.alias === alias ? lastAliasCheck.available : null;
            if (aliasAvailable === null) {
                aliasAvailable = await isAliasAvailable(alias);
            }
            if (!aliasAvailable) {
                throw new Error('Alias no disponible. Elige otro nombre.');
            }

            const passwordHash = await hashSharedPassword(password);

            await addDoc(collection(db, 'sharedAccess'), {
                ownerId,
                ownerEmail: auth.currentUser.email,
                email,
                passwordHash,
                plainPassword: password,
                createdAt: getChileDateTime()
            });

            sharedAccessForm.reset();
            lastAliasCheck = { alias: '', available: null };
            if (sharedPasswordHelper) {
                sharedPasswordHelper.textContent = `Comparte estas credenciales: ${email} / ${password}. También quedarán visibles en la lista de colaboradores.`;
                sharedPasswordHelper.classList.remove('text-muted');
                sharedPasswordHelper.classList.add('text-success');
            }
            setAliasHelperState(`${email} creado correctamente`, 'success');
            await loadSharedAccessEntries();
            showSuccess('Acceso compartido creado');
        } catch (error) {
            showError(error.message || 'Error al crear acceso');
        } finally {
            hideLoading(submitBtn);
        }
    });
}

async function loadSharedAccessEntries() {
    const list = document.getElementById('sharedAccessList');
    const count = document.getElementById('sharedAccessCount');
    if (!list || !isOwnerSessionActive()) {
        if (list && !isOwnerSessionActive()) {
            list.innerHTML = '<p class="text-muted mb-0">Inicia sesión con la cuenta principal para gestionar colaboradores.</p>';
        }
        if (count) count.textContent = '0 activos';
        sharedAccessEntries = [];
        return;
    }

    try {
        const ownerId = auth.currentUser?.uid;
        if (!ownerId) return;
        const accessQuery = query(
            collection(db, 'sharedAccess'),
            where('ownerId', '==', ownerId)
        );
        const snapshot = await getDocs(accessQuery);
        sharedAccessEntries = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
        renderSharedAccessList();
    } catch (error) {
        console.error('Error al cargar colaboradores:', error);
        if (list) {
            list.innerHTML = '<p class="text-danger mb-0">Error al cargar colaboradores.</p>';
        }
    }
}

function renderSharedAccessList() {
    const list = document.getElementById('sharedAccessList');
    const count = document.getElementById('sharedAccessCount');
    if (!list) return;

    if (!sharedAccessEntries.length) {
        list.innerHTML = '<p class="text-muted mb-0">No has agregado colaboradores.</p>';
    } else {
        list.innerHTML = sharedAccessEntries.map(entry => `
            <div class="shared-access-entry">
                <div class="shared-access-info">
                    <strong>${entry.email}</strong>
                    <div class="access-meta">Creado el ${formatChileDate(entry.createdAt)}</div>
                    <div class="shared-password">
                        ${entry.plainPassword
                            ? `<span>Contraseña:</span> <code>${entry.plainPassword}</code>`
                            : '<span class="text-muted">Contraseña no disponible</span>'}
                    </div>
                </div>
                <div class="shared-access-actions">
                    <button class="btn btn-sm btn-outline-danger" onclick="removeSharedAccess('${entry.id}')">
                        <i class="fas fa-user-minus me-1"></i>Revocar
                    </button>
                </div>
            </div>
        `).join('');
    }

    if (count) {
        count.textContent = `${sharedAccessEntries.length} activos`;
    }
}

window.removeSharedAccess = async (accessId) => {
    if (!isOwnerSessionActive()) {
        showError('Solo el propietario puede revocar accesos');
        return;
    }

    if (!confirm('¿Eliminar el acceso compartido seleccionado?')) return;
    try {
        await deleteDoc(doc(db, 'sharedAccess', accessId));
        await loadSharedAccessEntries();
        showSuccess('Acceso revocado');
    } catch (error) {
        showError('No se pudo revocar el acceso');
    }
};

window.deleteFilter = async function(filterId) {
    if (confirm('¿Eliminar este filtro?')) {
        try {
            await deleteDoc(doc(db, 'filters', filterId));
            if (currentFilter?.id === filterId) {
                clearFilters();
            }
            loadFilters();
            showSuccess('Filtro eliminado exitosamente');
        } catch (error) {
            showError('Error al eliminar filtro: ' + error.message);
        }
    }
};

// Función para aplicar filtros y ordenamiento
function applyFiltersAndSort() {
    let filteredSales = [...currentSales];
    
    // Aplicar filtro si existe
    if (currentFilter) {
        filteredSales = filteredSales.filter(sale => {
            const searchText = `${sale.product} ${sale.client} ${sale.notes || ''}`.toLowerCase();
            return currentFilter.keywords.some(keyword => searchText.includes(keyword));
        });
    }
    
    // Aplicar ordenamiento
    const sortOrder = document.getElementById('sortOrder').value;
    filteredSales.sort((a, b) => {
        switch (sortOrder) {
            case 'newest':
                return new Date(b.createdAt) - new Date(a.createdAt);
            case 'oldest':
                return new Date(a.createdAt) - new Date(b.createdAt);
            case 'nameAsc':
                return a.product.localeCompare(b.product);
            case 'nameDesc':
                return b.product.localeCompare(a.product);
            default:
                return 0;
        }
    });
    
    // Actualizar vista
    renderSales(filteredSales);
}

// Add edit and renewal functions
async function fillEditModal(saleId) {
    try {
        const saleDoc = await getDoc(doc(db, 'sales', saleId));
        const sale = saleDoc.data();

        if (!inventoryProducts.length) {
            await loadProducts();
        } else {
            populateSaleProductOptions();
        }
        
        document.getElementById('editSaleId').value = saleId;
        document.getElementById('editProductName').value = sale.product;
        document.getElementById('editClientName').value = sale.client;
        document.getElementById('editPrice').value = sale.price;
        document.getElementById('editNotes').value = sale.notes || '';
        document.getElementById('editWhatsapp').value = sale.whatsapp || '';
        document.getElementById('editEmail').value = sale.email || '';
        document.getElementById('editInstagram').value = sale.instagram || '';
        document.getElementById('editFacebook').value = sale.facebook || '';
        
        if (sale.accountCredentials) {
            document.getElementById('editAccountUser').value = sale.accountCredentials.username || '';
            document.getElementById('editAccountPassword').value = sale.accountCredentials.password || '';
            document.getElementById('editAccountProfile').value = sale.accountCredentials.profile || '';
            document.getElementById('editProfilePin').value = sale.accountCredentials.pin || '';
        }

        if (editSaleProductSelect) {
            editSaleProductSelect.value = sale.productId || '';
            editSaleProductSelect.dispatchEvent(new Event('change'));
        }
        if (editSaleProductProfileInput) {
            editSaleProductProfileInput.value = sale.productProfile || '';
        }
        
        new bootstrap.Modal(document.getElementById('editModal')).show();
    } catch (error) {
        alert('Error al cargar los datos: ' + error.message);
    }
}

// Add function to calculate total days for renewal
function calculateRenewalDays(currentEndDate, duration, periodType) {
    const remainingDays = calculateDaysRemaining(null, currentEndDate);
    const newDays = calculateDurationInDays(duration, periodType);
    
    // If subscription hasn't expired yet, add remaining days
    return remainingDays > 0 ? newDays + remainingDays : newDays;
}

// Update renewSale function
async function fillRenewModal(saleId) {
    try {
        const saleDoc = await getDoc(doc(db, 'sales', saleId));
        const sale = saleDoc.data();
        
        // Check if sale is expired before allowing renewal
        if (!isSaleExpired(sale.endDate)) {
            alert('Solo se pueden renovar suscripciones vencidas.');
            return;
        }

        // Store the complete sale data including endDate
        document.getElementById('renewSaleId').value = saleId;
        document.getElementById('renewCurrentSale').value = JSON.stringify({
            product: sale.product,
            client: sale.client,
            whatsapp: sale.whatsapp || '',
            email: sale.email || '',
            instagram: sale.instagram || '',
            facebook: sale.facebook || '',
            notes: sale.notes || '',
            accountCredentials: sale.accountCredentials || {},
            userId: sale.userId,
            endDate: sale.endDate,
            productId: sale.productId || null,
            productProfile: sale.productProfile || null
        });
        
        // Remove remaining days info since it's expired
        const oldInfo = document.querySelector('#renewModal .alert');
        if (oldInfo) oldInfo.remove();
        
        // Pre-fill form fields but start from current date
        document.getElementById('renewDuration').value = sale.originalDuration;
        document.getElementById('renewPeriodType').value = sale.periodType;
        document.getElementById('renewPrice').value = sale.price;
        
        new bootstrap.Modal(document.getElementById('renewModal')).show();
    } catch (error) {
        alert('Error al cargar los datos para renovación: ' + error.message);
    }
}

// Add form event listeners
document.getElementById('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saleId = document.getElementById('editSaleId').value;
    const linkedProductId = editSaleProductSelect?.value || '';
    const linkedProfile = (editSaleProductProfileInput?.value || '').trim();
    
    try {
        await updateDoc(doc(db, 'sales', saleId), {
            product: document.getElementById('editProductName').value,
            client: document.getElementById('editClientName').value,
            price: parseInt(document.getElementById('editPrice').value),
            notes: document.getElementById('editNotes').value || '',
            whatsapp: document.getElementById('editWhatsapp').value,
            email: document.getElementById('editEmail').value,
            instagram: document.getElementById('editInstagram').value,
            facebook: document.getElementById('editFacebook').value,
            accountCredentials: {
                username: document.getElementById('editAccountUser').value || null,
                password: document.getElementById('editAccountPassword').value || null,
                profile: document.getElementById('editAccountProfile').value || null,
                pin: document.getElementById('editProfilePin').value || null
            },
            productId: linkedProductId || null,
            productProfile: linkedProfile || null,
            updatedAt: getChileDateTime() // Agregar timestamp de actualización
        });
        
        bootstrap.Modal.getInstance(document.getElementById('editModal')).hide();
        loadSales();
    } catch (error) {
        alert('Error al guardar los cambios: ' + error.message);
    }
});

// Update renewal form submission
document.getElementById('renewForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    try {
        const currentSaleData = JSON.parse(document.getElementById('renewCurrentSale').value);
        const duration = parseInt(document.getElementById('renewDuration').value);
        const periodType = document.getElementById('renewPeriodType').value;
        
        // Calculate total days including remaining days
        const totalDays = calculateRenewalDays(currentSaleData.endDate, duration, periodType);
        
        // Calculate dates starting from current end date if not expired
        const now = getChileDateTime();
        const currentEnd = new Date(currentSaleData.endDate);
        const startDate = currentEnd > now ? currentEnd : now;
        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + totalDays);

        const renewalSale = {
            ...currentSaleData,
            price: parseInt(document.getElementById('renewPrice').value),
            duration: totalDays,
            periodType: periodType,
            originalDuration: duration,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            status: 'active',
            createdAt: now.toISOString(),
            isRenewal: true,
            previousSaleId: document.getElementById('renewSaleId').value,
            totalDaysIncludingRemaining: totalDays
        };

        // Create new renewal record
        await addDoc(collection(db, 'sales'), renewalSale);
        
        // Update original sale as completed
        await updateDoc(doc(db, 'sales', document.getElementById('renewSaleId').value), {
            status: 'completed',
            renewedAt: getChileDateTime()
        });
        
        const modal = bootstrap.Modal.getInstance(document.getElementById('renewModal'));
        modal.hide();
        
        // Clear form
        document.getElementById('renewForm').reset();
        
        // Reload sales list
        loadSales();
        
        alert('Suscripción renovada exitosamente');
    } catch (error) {
        console.error('Error en renovación:', error);
        alert('Error al renovar la suscripción: ' + error.message);
    }
});

// Make functions available globally
window.editSale = fillEditModal;
window.renewSale = fillRenewModal;

// Add password visibility toggle function
window.togglePasswordVisibility = function(element) {
    const passwordText = element.querySelector('.password-text');
    const dots = element.firstChild;
    
    if (passwordText.style.display === 'none') {
        dots.style.display = 'none';
        passwordText.style.display = 'inline';
        setTimeout(() => {
            dots.style.display = 'inline';
            passwordText.style.display = 'none';
        }, 2000);
    }
};

// Update formatAccountInfo function
function formatAccountInfo(sale) {
    if (!sale.accountCredentials || 
        (!sale.accountCredentials.username && !sale.accountCredentials.password)) {
        return '';
    }

    const copyButton = `
        <div class="mt-2">
            <button type="button" class="btn btn-sm btn-outline-secondary" onclick="copyToClipboard('${encodeURIComponent(JSON.stringify(sale))}')">
                <i class="fas fa-copy me-1"></i>Copiar datos de acceso
            </button>
        </div>
    `;

    return `
        <div class="account-info mb-3 p-2 bg-light rounded">
            <p class="mb-1 fw-bold"><i class="fas fa-user-shield me-2"></i>Datos de Acceso:</p>
            ${sale.accountCredentials.username ? 
                `<p class="mb-1 small"><i class="fas fa-user me-2"></i>Usuario: ${sale.accountCredentials.username}</p>` : ''}
            ${sale.accountCredentials.password ?
                `<p class="mb-1 small">
                    <i class="fas fa-key me-2"></i>Contraseña: 
                    <span class="password-wrapper">
                        <span class="password-dots">${'•'.repeat(sale.accountCredentials.password.length)}</span>
                        <span class="password-text" style="display:none">${sale.accountCredentials.password}</span>
                        <button type="button" class="btn btn-sm btn-outline-secondary ms-2" onclick="togglePasswordDisplay(this)">
                            <i class="fas fa-eye"></i>
                        </button>
                    </span>
                </p>` : ''}
            ${sale.accountCredentials.profile ?
                `<p class="mb-1 small"><i class="fas fa-user-circle me-2"></i>Perfil: ${sale.accountCredentials.profile}</p>` : ''}
            ${sale.accountCredentials.pin ?
                `<p class="mb-1 small">
                    <i class="fas fa-key me-2"></i>PIN: 
                    <span class="password-wrapper">
                        <span class="password-dots">${'•'.repeat(sale.accountCredentials.pin.length)}</span>
                        <span class="password-text" style="display:none">${sale.accountCredentials.pin}</span>
                        <button type="button" class="btn btn-sm btn-outline-secondary ms-2" onclick="togglePasswordDisplay(this)">
                            <i class="fas fa-eye"></i>
                        </button>
                    </span>
                </p>` : ''}
            ${copyButton}
        </div>
    `;
}

// Add new password toggle function
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

// Keep only the clipboard functionality
window.copyToClipboard = function(saleData) {
    const sale = JSON.parse(decodeURIComponent(saleData));
    const info = formatSaleInfoForSharing(sale);
    
    navigator.clipboard.writeText(info).then(() => {
        // Show success message
        const toast = document.createElement('div');
        toast.className = 'toast-notification';
        toast.textContent = '✅ Datos copiados al portapapeles';
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.remove();
        }, 2000);
    }).catch(err => {
        alert('Error al copiar: ' + err);
    });
};

// Add dashboard stats update function
// Modificar la función updateDashboardStats para evitar NaN
function updateDashboardStats({ active, nearExpiry, expiringToday, expired, totalAmount }) {
    const elements = {
        activeSubscriptions: {
            element: document.getElementById('activeSubscriptions'),
            current: parseInt(document.getElementById('activeSubscriptions').textContent) || 0,
            target: active || 0
        },
        nearExpiration: {
            element: document.getElementById('nearExpiration'),
            current: parseInt(document.getElementById('nearExpiration').textContent) || 0,
            target: nearExpiry || 0
        },
        expiringToday: {
            element: document.getElementById('expiringToday'),
            current: parseInt(document.getElementById('expiringToday').textContent) || 0,
            target: expiringToday || 0
        },
        expiredSubscriptions: {
            element: document.getElementById('expiredSubscriptions'),
            current: parseInt(document.getElementById('expiredSubscriptions').textContent) || 0,
            target: expired || 0
        }
    };

    // Animate number changes
    for (const key in elements) {
        const { element, current, target } = elements[key];
        if (element) { // Verificar que el elemento exista
            animateNumber(element, current, target);
        }
    }

    // Update total amount with fallback to 0
    document.getElementById('totalSales').innerHTML = 
        `<i class="fas fa-dollar-sign me-2"></i>Total: ${formatCLP(totalAmount || 0)}`;
}

// Add smooth number animation
function animateNumber(element, start, end) {
    const duration = 500; // milliseconds
    const startTime = performance.now();
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        const value = Math.floor(start + (end - start) * progress);
        element.textContent = value;
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

// Add trash management functions
async function updateTrashCount() {
    try {
        const ownerId = getActiveUserId();
        if (!ownerId) return;

        const trashQuery = query(
            collection(db, 'trash'),
            where('userId', '==', ownerId)
        );
        
        const trashSnapshot = await getDocs(trashQuery);
        const count = trashSnapshot.size;
        document.getElementById('trashCount').textContent = count;
        document.getElementById('emptyTrashBtn').style.display = count > 0 ? 'inline-block' : 'none';
    } catch (error) {
        console.error('Error counting trash:', error);
    }
}

async function loadTrashItems() {
    const trashList = document.getElementById('trashList');
    trashList.innerHTML = '<div class="text-center"><div class="spinner-border"></div></div>';
    
    try {
        const ownerId = getActiveUserId();
        if (!ownerId) {
            throw new Error('No hay usuario activo');
        }

        const trashQuery = query(
            collection(db, 'trash'),
            where('userId', '==', ownerId)
        );
        
        const snapshot = await getDocs(trashQuery);
        trashList.innerHTML = '';
        
        if (snapshot.empty) {
            trashList.innerHTML = `
                <div class="text-center text-muted p-4">
                    <i class="fas fa-trash fa-3x mb-3"></i>
                    <p>La papelera está vacía</p>
                </div>
            `;
            return;
        }

        snapshot.forEach(doc => {
            const item = doc.data();
            trashList.innerHTML += `
                <div class="list-group-item">
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <h6 class="mb-1">${item.product}</h6>
                            <p class="mb-1 small text-muted">
                                Cliente: ${item.client}<br>
                                Eliminado: ${formatChileDate(item.deletedAt)}
                            </p>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-success btn-sm" onclick="restoreFromTrash('${doc.id}')">
                                <i class="fas fa-undo me-1"></i>Restaurar
                            </button>
                            <button class="btn btn-danger btn-sm" onclick="deleteFromTrash('${doc.id}')">
                                <i class="fas fa-times me-1"></i>Eliminar
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });
    } catch (error) {
        trashList.innerHTML = `
            <div class="alert alert-danger">
                Error al cargar la papelera: ${error.message}
            </div>
        `;
    }
}

window.restoreFromTrash = async (trashId) => {
    try {
        const trashDoc = await getDoc(doc(db, 'trash', trashId));
        const itemData = trashDoc.data();
        
        // Verificar que el elemento pertenezca al usuario actual
        if (itemData.userId !== getActiveUserId()) {
            throw new Error('No tienes permiso para restaurar este elemento');
        }
        
        // Remove trash-specific fields but preserve userId
        const { deletedAt, originalId, ...saleData } = itemData;
        
        // Restore to sales collection
        await addDoc(collection(db, 'sales'), {
            ...saleData,
            userId: getActiveUserId()
        });
        
        // Remove from trash
        await deleteDoc(doc(db, 'trash', trashId));
        
        loadTrashItems();
        loadSales();
        updateTrashCount();
        
        alert('Venta restaurada exitosamente');
    } catch (error) {
        alert('Error al restaurar: ' + error.message);
    }
};

window.deleteFromTrash = async (trashId) => {
    if (confirm('¿Eliminar permanentemente esta venta?')) {
        try {
            await deleteDoc(doc(db, 'trash', trashId));
            loadTrashItems();
            updateTrashCount();
        } catch (error) {
            alert('Error al eliminar: ' + error.message);
        }
    }
};

window.emptyTrash = async () => {
    if (confirm('¿Estás seguro de vaciar la papelera? Esta acción no se puede deshacer.')) {
        try {
            const ownerId = getActiveUserId();
            if (!ownerId) {
                throw new Error('No hay usuario activo');
            }
            const trashQuery = query(
                collection(db, 'trash'),
                where('userId', '==', ownerId)
            );
            
            const snapshot = await getDocs(trashQuery);
            const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
            await Promise.all(deletePromises);
            
            loadTrashItems();
            updateTrashCount();
            alert('Papelera vaciada exitosamente');
        } catch (error) {
            alert('Error al vaciar la papelera: ' + error.message);
        }
    }
};

// Update modal initialization
document.getElementById('trashModal').addEventListener('show.bs.modal', () => {
    loadTrashItems();
});

const collaboratorsModal = document.getElementById('collaboratorsModal');
if (collaboratorsModal) {
    collaboratorsModal.addEventListener('show.bs.modal', () => {
        if (isOwnerSessionActive()) {
            loadSharedAccessEntries();
        }
    });
}

// Agregar event listener para ordenamiento
window.applySorting = function() {
    applyFiltersAndSort();
};

auth.onAuthStateChanged(async (user) => {
    if (user && isSharedSessionActive()) {
        clearSharedSession();
    }
    await refreshApplicationState(user);
});

async function refreshApplicationState(user) {
    const splashScreen = document.getElementById('splashScreen');
    const authContainer = document.getElementById('authContainer');
    const dashboardContainer = document.getElementById('dashboardContainer');
    const activeUserId = getActiveUserId();

    if (!activeUserId) {
        clearAutoUpdates();
        currentSales = [];
        currentFilter = null;
        updateDashboardStats({ active: 0, nearExpiry: 0, expiringToday: 0, expired: 0, totalAmount: 0 });
        if (authContainer && dashboardContainer) {
            authContainer.style.display = 'block';
            dashboardContainer.style.display = 'none';
        }
        document.getElementById('salesList').innerHTML = '';
        document.getElementById('filtersList').innerHTML = '';
        document.getElementById('trashCount').textContent = '0';
        updateSharedSessionBadge();
        if (splashScreen) {
            splashScreen.classList.add('fade-out');
            setTimeout(() => {
                splashScreen.style.display = 'none';
            }, 300);
        }
        return;
    }

    try {
        if (isSharedSessionActive()) {
            const isValid = await validateSharedAccessState();
            if (!isValid) {
                await refreshApplicationState(auth.currentUser);
                return;
            }
        }

        const verificationBadge = document.getElementById('verificationBadge');
        const ownerDoc = await getDoc(doc(db, 'users', activeUserId));
        const ownerData = ownerDoc.data();

        if (verificationBadge) {
            if (ownerData?.isVerified) {
                verificationBadge.className = 'badge bg-success';
                verificationBadge.innerHTML = '<i class="fas fa-check-circle"></i> Cuenta verificada';
                verificationBadge.onclick = null;
            } else {
                verificationBadge.className = 'badge bg-warning cursor-pointer';
                verificationBadge.innerHTML = '<i class="fas fa-exclamation-circle"></i> Cuenta sin verificar';
                verificationBadge.onclick = () => {
                    new bootstrap.Modal(document.getElementById('verificationModal')).show();
                };
            }
        }

        if (authContainer && dashboardContainer) {
            authContainer.style.display = 'none';
            dashboardContainer.style.display = 'block';
        }

        updateSharedSessionBadge();

        await Promise.all([
            loadSales(),
            loadProducts(),
            loadFilters(),
            updateTrashCount(),
            isOwnerSessionActive() ? loadSharedAccessEntries() : Promise.resolve()
        ]);
    } catch (error) {
        console.error('Error durante la inicialización:', error);
        showError('Error al cargar la aplicación');
    } finally {
        if (splashScreen) {
            splashScreen.classList.add('fade-out');
            setTimeout(() => {
                splashScreen.style.display = 'none';
            }, 300);
        }
    }
}

// Agregar el manejador del formulario de verificación
document.getElementById('verificationForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const code = document.getElementById('verificationCode').value.trim();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    
    try {
        showLoading(submitBtn);
        
        if (code !== 'SELLSTREAM20') {
            throw new Error('Código de verificación incorrecto');
        }

        // Si el código es correcto, actualizar el estado de verificación
        const ownerId = getActiveUserId();
        if (!ownerId) {
            throw new Error('No hay usuario activo para verificar');
        }

        await setDoc(doc(db, 'users', ownerId), {
            isVerified: true,
            verifiedAt: new Date().toISOString()
        }, { merge: true });

        // Actualizar UI
        const verificationBadge = document.getElementById('verificationBadge');
        verificationBadge.className = 'badge bg-success';
        verificationBadge.innerHTML = '<i class="fas fa-check-circle"></i> Cuenta verificada';
        verificationBadge.onclick = null;

        // Cerrar el modal y mostrar mensaje de éxito
        bootstrap.Modal.getInstance(document.getElementById('verificationModal')).hide();
        showSuccess('¡Cuenta verificada exitosamente!');
        
    } catch (error) {
        showError(error.message);
    } finally {
        hideLoading(submitBtn);
    }
});

// Exponer explícitamente las funciones necesarias al objeto window
window.deleteSale = async (saleId) => {
    if (confirm('¿Mover esta venta a la papelera?')) {
        try {
            const saleDoc = await getDoc(doc(db, 'sales', saleId));
            const saleData = saleDoc.data();
            
            // Verificar que la venta pertenezca al usuario actual
            if (saleData.userId !== getActiveUserId()) {
                throw new Error('No tienes permiso para eliminar esta venta');
            }
            
            await addDoc(collection(db, 'trash'), {
                ...saleData,
                originalId: saleId,
                deletedAt: getChileDateTime(),
                userId: getActiveUserId()
            });
            
            await deleteDoc(doc(db, 'sales', saleId));
            
            loadSales();
            updateTrashCount();
            showSuccess('Venta movida a la papelera');
        } catch (error) {
            showError('Error al mover a papelera: ' + error.message);
        }
    }
};

// Crear función toggleStatus
window.toggleStatus = async (saleId, currentStatus) => {
    try {
        const saleRef = doc(db, 'sales', saleId);
        const saleDoc = await getDoc(saleRef);
        const saleData = saleDoc.data();

        // Verificar que la venta pertenezca al usuario actual
        if (saleData.userId !== getActiveUserId()) {
            throw new Error('No tienes permiso para modificar esta venta');
        }

        await updateDoc(saleRef, {
            status: currentStatus === 'completed' ? 'active' : 'completed',
            updatedAt: getChileDateTime()
        });
        
        loadSales();
        showSuccess(`Venta ${currentStatus === 'completed' ? 'reactivada' : 'completada'} exitosamente`);
    } catch (error) {
        showError('Error al cambiar estado: ' + error.message);
    }
};

// Asegurarse de que todas las funciones que se llaman desde el HTML estén expuestas
Object.assign(window, {
    editSale,
    renewSale,
    togglePasswordDisplay,
    copyToClipboard,
    clearFilters,
    applyFilter,
    deleteFilter,
    applySorting,
    emptyTrash,
    restoreFromTrash,
    removeSharedAccess,
    deleteFromTrash,
    togglePassword,
    toggleStatus, // Agregar toggleStatus a la lista
    deleteSale,
    deleteProduct
});

// Agregar después de la inicialización de la aplicación
const shareButton = document.getElementById('shareButton');
const shareModal = new bootstrap.Modal(document.getElementById('shareModal'));
const collaboratorGuideModalElement = document.getElementById('collaboratorGuideModal');
const collaboratorGuideTriggers = document.querySelectorAll('#openCollaboratorGuide, #collaboratorHelpLink');
let collaboratorGuideModal = null;

if (collaboratorGuideModalElement) {
    collaboratorGuideModal = new bootstrap.Modal(collaboratorGuideModalElement);
    collaboratorGuideTriggers.forEach((trigger) => {
        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            collaboratorGuideModal.show();
        });
    });
}

// Configuración para compartir
const shareData = {
    title: 'SellStream - Sistema de Gestión de Suscripciones',
    text: '¡Descubre SellStream! La manera más fácil de gestionar y dar seguimiento a tus suscripciones.',
    url: 'https://sellstream.trustzonestore.com'
};

// Handler para el botón de compartir
shareButton.addEventListener('click', async () => {
    // Si el navegador soporta Web Share API y está en un contexto seguro
    if (navigator.share && window.isSecureContext) {
        try {
            await navigator.share(shareData);
            showSuccess('¡Gracias por compartir!');
        } catch (err) {
            // Si el usuario cancela la acción, no mostrar error
            if (err.name !== 'AbortError') {
                shareModal.show();
            }
        }
    } else {
        // Fallback al modal de compartir
        shareModal.show();
    }
});

// Manejadores para los botones de redes sociales
document.getElementById('shareWhatsApp').addEventListener('click', () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(shareData.text + ' ' + shareData.url)}`);
});

document.getElementById('shareFacebook').addEventListener('click', () => {
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareData.url)}`);
});

document.getElementById('shareTwitter').addEventListener('click', () => {
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareData.text)}&url=${encodeURIComponent(shareData.url)}`);
});

document.getElementById('shareLinkedIn').addEventListener('click', () => {
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareData.url)}`);
});

// Manejar la copia del enlace
document.getElementById('copyLinkBtn').addEventListener('click', async () => {
    const shareLink = document.getElementById('shareLink');
    
    try {
        await navigator.clipboard.writeText(shareLink.value);
        showSuccess('¡Enlace copiado!');
        
        // Efecto visual en el botón
        const btn = document.getElementById('copyLinkBtn');
        btn.innerHTML = '<i class="fas fa-check me-2"></i>Copiado';
        btn.classList.replace('btn-outline-primary', 'btn-success');
        
        setTimeout(() => {
            btn.innerHTML = '<i class="fas fa-copy me-2"></i>Copiar';
            btn.classList.replace('btn-success', 'btn-outline-primary');
        }, 2000);
    } catch (err) {
        showError('Error al copiar el enlace');
    }
});

// Reemplazar el handler del botón de tutoriales
tutorialsButton.addEventListener('click', () => {
    window.location.href = 'tutorials.html';
});

// Agregar handler del botón del foro
document.getElementById('forumButton').addEventListener('click', () => {
    window.location.href = 'forum.html';
});

const inventoryButton = document.getElementById('inventoryButton');
if (inventoryButton) {
    inventoryButton.addEventListener('click', () => {
        window.location.href = 'inventory.html';
    });
}

// Eliminar el código del modal de tutoriales que ya no se usará

// Agregar función para actualizar una suscripción específica
async function updateSaleStatus(saleId) {
    try {
        const saleRef = doc(db, 'sales', saleId);
        const saleDoc = await getDoc(saleRef);
        
        if (!saleDoc.exists()) return;
        
        const sale = saleDoc.data();
        const daysRemaining = calculateDaysRemaining(sale.startDate, sale.endDate);
        const statusInfo = getStatusInfo(daysRemaining, sale.status, sale);
        
        // Encontrar el elemento de la suscripción en el DOM
        const saleCard = document.querySelector(`[data-sale-id="${saleId}"]`);
        if (saleCard) {
            // Actualizar el badge de días restantes
            const daysRemainingBadge = saleCard.querySelector('.days-remaining');
            if (daysRemainingBadge) {
                daysRemainingBadge.textContent = statusInfo.text;
                daysRemainingBadge.className = `days-remaining ${statusInfo.class}`;
            }
            
            // Actualizar la barra de progreso
            const progressBar = saleCard.querySelector('.progress-bar');
            if (progressBar) {
                progressBar.style.width = `${statusInfo.elapsedPercentage}%`;
                progressBar.className = `progress-bar ${statusInfo.class}`;
            }
            
            // Actualizar el estado visual de la tarjeta
            saleCard.dataset.status = statusInfo.isExpired ? 'expired' : 
                                    statusInfo.isNearExpiry ? 'near-expiry' : 'active';
        }
        
        // Si la suscripción ha vencido y estaba activa, actualizarla en la base de datos
        if (daysRemaining < 0 && sale.status === 'active') {
            await updateDoc(saleRef, {
                status: 'expired',
                updatedAt: getChileDateTime()
            });
        }
    } catch (error) {
        console.error('Error actualizando estado de suscripción:', error);
    }
}

function startAutoUpdates(sales) {
    // Limpiar intervalos anteriores
    clearAutoUpdates();
    
    // Crear nuevos intervalos para cada suscripción activa
    sales.forEach(sale => {
        if (sale.status !== 'completed') {
            // Actualizar cada minuto
            const intervalId = setInterval(() => updateSaleStatus(sale.id), 60000);
            updateIntervals.set(sale.id, intervalId);
        }
    });
}

function clearAutoUpdates() {
    updateIntervals.forEach(intervalId => clearInterval(intervalId));
    updateIntervals.clear();
}

// Actualizar las estadísticas inmediatamente después de cada cambio
function updateStats() {
    const sales = document.querySelectorAll('.sale-card');
    let stats = { active: 0, nearExpiry: 0, expiringToday: 0, expired: 0, totalAmount: 0 };
    
    sales.forEach(sale => {
        const status = sale.dataset.status;
        const price = parseInt(sale.dataset.price || 0);
        
        if (status === 'expired') stats.expired++;
        else if (status === 'near-expiry') stats.nearExpiry++;
        else if (sale.querySelector('.days-remaining').textContent.includes('hoy')) stats.expiringToday++;
        else stats.active++;
        
        stats.totalAmount += price;
    });
    
    updateDashboardStats(stats);
}
