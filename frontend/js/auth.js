const API_URL = `${window.location.origin}/api`;

// Redirect if already logged in
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
const currentPath = window.location.pathname;

if (token && user && (currentPath.endsWith('login.html') || currentPath.endsWith('register.html') || currentPath.endsWith('/') || currentPath.endsWith('index.html'))) {
  if (user.role === 'admin') {
    window.location.replace('admin.html');
  } else {
    window.location.replace('menu.html');
  }
}

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const errorMsg = document.getElementById('error-msg');

// --- Google reCAPTCHA for Login (Invisible mode) ---
window.loginRecaptchaWidgetId = null;
window.recaptchaSiteKey = null;
let recaptchaResolve = null;

window._initLoginRecaptchaWidget = function () {
  const container = document.getElementById('login-recaptcha');
  if (!container || window.loginRecaptchaWidgetId !== null) return;
  if (!window.recaptchaSiteKey) return;
  if (typeof grecaptcha === 'undefined' || typeof grecaptcha.render !== 'function') return;

  try {
    window.loginRecaptchaWidgetId = grecaptcha.render('login-recaptcha', {
      sitekey: window.recaptchaSiteKey,
      size: 'invisible',
      badge: 'bottomright',
      callback: function (token) {
        if (typeof recaptchaResolve === 'function') {
          const fn = recaptchaResolve;
          recaptchaResolve = null;
          fn(token || '');
        }
      },
      'error-callback': function () {
        if (typeof recaptchaResolve === 'function') {
          const fn = recaptchaResolve;
          recaptchaResolve = null;
          fn('');
        }
      }
    });
  } catch (err) {
    console.warn('[reCAPTCHA] render error:', err);
  }
};

async function initLoginRecaptcha() {
  const container = document.getElementById('login-recaptcha');
  if (!container) return;

  try {
    const res = await fetch(`${API_URL}/auth/recaptcha-config`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.siteKey) {
      window.recaptchaSiteKey = data.siteKey;

      if (typeof grecaptcha !== 'undefined' && typeof grecaptcha.render === 'function') {
        window._initLoginRecaptchaWidget();
      } else if (window._recaptchaApiLoaded) {
        window._initLoginRecaptchaWidget();
      } else if (!document.getElementById('google-recaptcha-script')) {
        window.onGoogleRecaptchaLoaded = function () {
          window._initLoginRecaptchaWidget();
        };
        const script = document.createElement('script');
        script.id = 'google-recaptcha-script';
        script.src = 'https://www.google.com/recaptcha/api.js?onload=onGoogleRecaptchaLoaded&render=explicit';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    }
  } catch (err) {
    console.warn('[reCAPTCHA] Failed to load config:', err);
  }
}

function getLoginRecaptchaToken() {
  if (typeof grecaptcha === 'undefined' || window.loginRecaptchaWidgetId === null || window.loginRecaptchaWidgetId === undefined) {
    return Promise.resolve('');
  }

  const existingToken = grecaptcha.getResponse(window.loginRecaptchaWidgetId);
  if (existingToken) {
    return Promise.resolve(existingToken);
  }

  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        recaptchaResolve = null;
        resolve('');
      }
    }, 6000);

    recaptchaResolve = (token) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        recaptchaResolve = null;
        resolve(token || '');
      }
    };

    try {
      grecaptcha.execute(window.loginRecaptchaWidgetId);
    } catch (err) {
      console.warn('[reCAPTCHA] execute error:', err);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        recaptchaResolve = null;
        resolve('');
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLoginRecaptcha);
} else {
  initLoginRecaptcha();
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const loginBtn = document.getElementById('login-btn') || loginForm.querySelector('button[type="submit"]');

    errorMsg.style.display = 'none';

    if (loginBtn) {
      loginBtn.disabled = true;
      loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Logging in...';
    }

    let recaptchaToken = '';
    if (window.recaptchaSiteKey) {
      recaptchaToken = await getLoginRecaptchaToken();
      if (!recaptchaToken && window.recaptchaSiteKey) {
        errorMsg.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Verification failed. Please try again.';
        errorMsg.style.display = 'block';
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.innerText = 'Login';
        }
        return;
      }
    }

    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, recaptchaToken })
      });
      const data = await res.json();
      
      if (!res.ok) {
        if (data.not_registered) {
          errorMsg.innerHTML = `<i class="fa-solid fa-user-xmark" style="margin-right:4px;"></i> ${data.error} <a href="register.html" style="color:var(--primary-color); font-weight:700; text-decoration:underline; display:inline-block; margin-left:4px;">Register here</a>`;
        } else {
          errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:4px;"></i> ${data.error}`;
        }
        errorMsg.style.display = 'block';

        if (window.grecaptcha && window.loginRecaptchaWidgetId !== null && window.loginRecaptchaWidgetId !== undefined) {
          try {
            grecaptcha.reset(window.loginRecaptchaWidgetId);
          } catch (_) {}
        }

        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.innerText = 'Login';
        }
      } else {
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        
        if (data.user.role === 'admin') {
          window.location.href = 'admin.html';
        } else {
          window.location.href = 'menu.html';
        }
      }
    } catch (err) {
      errorMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Network error. Please check your connection.';
      errorMsg.style.display = 'block';
      if (window.grecaptcha && window.loginRecaptchaWidgetId !== null && window.loginRecaptchaWidgetId !== undefined) {
        try {
          grecaptcha.reset(window.loginRecaptchaWidgetId);
        } catch (_) {}
      }
      if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.innerText = 'Login';
      }
    }
  });
}

// --- Firebase Phone Authentication Initialization ---
let firebaseConfig = null;
window.recaptchaVerifier = null;
window.confirmationResult = null;

async function initFirebasePhoneAuth() {
  const container = document.getElementById('recaptcha-container');
  if (!container) return;

  try {
    const res = await fetch(`${API_URL}/auth/firebase-config`);
    if (!res.ok) return;
    firebaseConfig = await res.json();

    if (firebaseConfig && firebaseConfig.apiKey && typeof firebase !== 'undefined') {
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }

      if (!window.recaptchaVerifier) {
        window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
          size: 'invisible',
          callback: () => {
            // Invisible reCAPTCHA solved
          },
          'expired-callback': () => {
            if (errorMsg) {
              errorMsg.innerText = 'Security verification expired. Please submit again.';
              errorMsg.style.display = 'block';
            }
          }
        });

        window.recaptchaVerifier.render().catch(err => {
          console.warn('[Firebase] reCAPTCHA render notice:', err);
        });
      }
    }
  } catch (err) {
    console.warn('[Firebase Phone Auth] Initialization notice:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFirebasePhoneAuth);
} else {
  initFirebasePhoneAuth();
}

if (registerForm) {
  const otpGroup = document.getElementById('otp-group');
  const otpInput = document.getElementById('otp');
  const infoMsg = document.getElementById('info-msg');
  const registerBtn = document.getElementById('register-btn');

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const phoneInput = document.getElementById('phone');
    const phone = phoneInput ? phoneInput.value.trim() : '';

    errorMsg.style.display = 'none';
    infoMsg.style.display = 'none';

    // Validate phone number (must be 10 digits starting with 6-9)
    let phoneDigits = '';
    if (phoneInput) {
      phoneDigits = phone.replace(/\D/g, '');
      if (phoneDigits.length !== 10 || !/^[6-9]\d{9}$/.test(phoneDigits)) {
        errorMsg.innerText = 'Please enter a valid 10-digit Indian mobile number (starting with 6, 7, 8, or 9).';
        errorMsg.style.display = 'block';
        return;
      }
    }

    // Step 1: Request verification code if OTP group is hidden
    if (otpGroup.style.display === 'none') {
      registerBtn.disabled = true;
      registerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying Details...';

      try {
        const res = await fetch(`${API_URL}/auth/send-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, phone })
        });
        const data = await res.json();

        if (!res.ok) {
          if (data.already_registered) {
            errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:4px;"></i> ${data.error} <a href="login.html" style="color:var(--primary-color); font-weight:700; text-decoration:underline; margin-left:4px;">Click here to Login</a>`;
          } else {
            errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:4px;"></i> ${data.error || 'Unable to verify details. Please try again.'}`;
          }
          errorMsg.style.display = 'block';
          registerBtn.disabled = false;
          registerBtn.innerText = 'Register';
          return;
        }

        // If Firebase Web SDK is available and configured
        if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0 && window.recaptchaVerifier) {
          registerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending Verification Code...';
          const internationalPhone = '+91' + phoneDigits;

          try {
            const confirmation = await firebase.auth().signInWithPhoneNumber(internationalPhone, window.recaptchaVerifier);
            window.confirmationResult = confirmation;

            infoMsg.innerHTML = `<i class="fa-solid fa-circle-check" style="color:var(--primary-color);"></i> Verification code sent to <strong>+91 ${phoneDigits}</strong>!`;
            infoMsg.style.display = 'block';
            otpGroup.style.display = 'block';
            otpInput.setAttribute('required', 'true');
            otpInput.focus();
            if (phoneInput) phoneInput.readOnly = true;
            document.getElementById('email').readOnly = true;
            registerBtn.disabled = false;
            registerBtn.innerText = 'Verify & Register';
          } catch (firebaseErr) {
            console.error('Firebase signInWithPhoneNumber error:', firebaseErr);
            if (window.grecaptcha && window.recaptchaVerifier) {
              try {
                const widgetId = await window.recaptchaVerifier.render();
                window.grecaptcha.reset(widgetId);
              } catch (e) {}
            }
            let userErrMsg = firebaseErr.message || 'Failed to send SMS verification code.';
            if (firebaseErr.code === 'auth/invalid-phone-number') {
              userErrMsg = 'The phone number format is invalid.';
            } else if (firebaseErr.code === 'auth/quota-exceeded' || firebaseErr.code === 'auth/too-many-requests') {
              userErrMsg = 'SMS quota exceeded or too many attempts. Please try again later.';
            } else if (firebaseErr.code === 'auth/captcha-check-failed') {
              userErrMsg = 'reCAPTCHA verification failed. Please try again.';
            } else if (firebaseErr.code === 'auth/operation-not-allowed') {
              userErrMsg = 'SMS is not enabled for India (+91) in Firebase. In Firebase Console, go to Authentication > Settings > SMS Region Policy and add India (+91), or add your phone under "Phone numbers for testing".';
            }
            errorMsg.innerText = userErrMsg;
            errorMsg.style.display = 'block';
            registerBtn.disabled = false;
            registerBtn.innerText = 'Register';
          }
        } else {
          // Dev sandbox or local OTP fallback
          infoMsg.innerHTML = `<i class="fa-solid fa-circle-info" style="color:var(--primary-color);"></i> ${data.message || 'Enter verification code to continue.'}`;
          infoMsg.style.display = 'block';
          otpGroup.style.display = 'block';
          otpInput.setAttribute('required', 'true');
          otpInput.focus();
          if (phoneInput) phoneInput.readOnly = true;
          document.getElementById('email').readOnly = true;
          registerBtn.disabled = false;
          registerBtn.innerText = 'Verify & Register';
        }
      } catch (err) {
        errorMsg.innerText = "Network error. Failed to initiate verification.";
        errorMsg.style.display = 'block';
        registerBtn.disabled = false;
        registerBtn.innerText = 'Register';
      }
      return;
    }

    // Step 2: OTP group is visible, verify code and complete registration
    const otp = otpInput.value.trim();
    if (!otp) {
      errorMsg.innerText = "Please enter the SMS verification code (OTP).";
      errorMsg.style.display = 'block';
      return;
    }

    registerBtn.disabled = true;

    // A) If Firebase confirmationResult is active, confirm the SMS OTP and retrieve Firebase ID token
    if (window.confirmationResult) {
      registerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying Code...';
      let firebaseIdToken = null;

      try {
        const userCredential = await window.confirmationResult.confirm(otp);
        firebaseIdToken = await userCredential.user.getIdToken();
      } catch (confirmErr) {
        console.error('Firebase confirm error:', confirmErr);
        let userErrMsg = 'Incorrect verification code. Please check and re-enter.';
        if (confirmErr.code === 'auth/invalid-verification-code') {
          userErrMsg = 'Incorrect verification code. Please check and re-enter.';
        } else if (confirmErr.code === 'auth/code-expired') {
          userErrMsg = 'Verification code has expired. Please refresh and request a new one.';
        }
        errorMsg.innerText = userErrMsg;
        errorMsg.style.display = 'block';
        registerBtn.disabled = false;
        registerBtn.innerText = 'Verify & Register';
        return;
      }

      // Submit verified ID token to backend
      registerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Setting Up Account...';
      try {
        const res = await fetch(`${API_URL}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password, phone, firebaseIdToken })
        });
        const regData = await res.json();

        if (!res.ok) {
          if (regData.already_registered) {
            errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:4px;"></i> ${regData.error} <a href="login.html" style="color:var(--primary-color); font-weight:700; text-decoration:underline; margin-left:4px;">Click here to Login</a>`;
          } else {
            errorMsg.innerText = regData.error || 'Unable to complete registration. Please try again.';
          }
          errorMsg.style.display = 'block';
          registerBtn.disabled = false;
          registerBtn.innerText = 'Verify & Register';
        } else {
          localStorage.setItem('token', regData.token);
          localStorage.setItem('user', JSON.stringify(regData.user));
          window.location.href = 'menu.html';
        }
      } catch (err) {
        errorMsg.innerText = "Connection issue. Please try registering again.";
        errorMsg.style.display = 'block';
        registerBtn.disabled = false;
        registerBtn.innerText = 'Verify & Register';
      }
      return;
    }

    // B) Fallback flow (Dev mode or local OTP)
    registerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Completing Registration...';

    try {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, phone, otp })
      });
      const regData = await res.json();

      if (!res.ok) {
        if (regData.already_registered) {
          errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:4px;"></i> ${regData.error} <a href="login.html" style="color:var(--primary-color); font-weight:700; text-decoration:underline; margin-left:4px;">Click here to Login</a>`;
        } else {
          errorMsg.innerText = regData.error || 'Registration failed.';
        }
        errorMsg.style.display = 'block';
        registerBtn.disabled = false;
        registerBtn.innerText = 'Verify & Register';
      } else {
        localStorage.setItem('token', regData.token);
        localStorage.setItem('user', JSON.stringify(regData.user));
        window.location.href = 'menu.html';
      }
    } catch (err) {
      errorMsg.innerText = "Network error. Failed to complete registration.";
      errorMsg.style.display = 'block';
      registerBtn.disabled = false;
      registerBtn.innerText = 'Verify & Register';
    }
  });

  // Real-time blur availability checks on email & phone
  const emailInput = document.getElementById('email');
  const phoneInput = document.getElementById('phone');

  async function checkFieldAvailability(field) {
    const emailVal = emailInput ? emailInput.value.trim() : '';
    const phoneVal = phoneInput ? phoneInput.value.trim() : '';

    if (field === 'email' && (!emailVal || !emailVal.includes('@'))) return;
    if (field === 'phone' && (!phoneVal || phoneVal.replace(/\D/g, '').length !== 10)) return;

    try {
      const params = new URLSearchParams();
      if (field === 'email' && emailVal) params.append('email', emailVal);
      if (field === 'phone' && phoneVal) params.append('phone', phoneVal);

      const res = await fetch(`${API_URL}/auth/check-availability?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (!data.available) {
          errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:4px;"></i> ${data.error} <a href="login.html" style="color:var(--primary-color); font-weight:700; text-decoration:underline; margin-left:4px;">Log in here</a>`;
          errorMsg.style.display = 'block';
        } else {
          if (errorMsg.innerHTML.includes('already registered')) {
            errorMsg.style.display = 'none';
          }
        }
      }
    } catch (e) {}
  }

  if (emailInput) {
    emailInput.addEventListener('blur', () => checkFieldAvailability('email'));
  }
  if (phoneInput) {
    phoneInput.addEventListener('blur', () => checkFieldAvailability('phone'));
  }
}

function logout() {
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('canteen_cart')) {
        localStorage.removeItem(key);
      }
    });
  } catch (_) {}
  window.location.replace('login.html');
}
window.logout = logout;

// --- Google Sign-In Integration ---
async function initGoogleSignIn() {
  const container = document.getElementById('google-auth-container');
  if (!container) return;

  try {
    const res = await fetch(`${API_URL}/auth/google-client-id`);
    if (!res.ok) return;
    const data = await res.json();
    
    if (data.clientId) {
      container.style.display = 'block';
      
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);

      window.handleGoogleCallback = async (response) => {
        try {
          const verifyRes = await fetch(`${API_URL}/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: response.credential })
          });
          const authData = await verifyRes.json();
          
          if (!verifyRes.ok) {
            if (errorMsg) {
              errorMsg.innerText = authData.error || 'Google login failed';
              errorMsg.style.display = 'block';
            }
          } else {
            localStorage.setItem('token', authData.token);
            localStorage.setItem('user', JSON.stringify(authData.user));
            
            if (authData.user.role === 'admin') {
              window.location.href = 'admin.html';
            } else {
              window.location.href = 'menu.html';
            }
          }
        } catch (err) {
          if (errorMsg) {
            errorMsg.innerText = "Network error during Google Sign In.";
            errorMsg.style.display = 'block';
          }
        }
      };

      script.onload = () => {
        google.accounts.id.initialize({
          client_id: data.clientId,
          callback: handleGoogleCallback,
          context: window.location.pathname.includes('register') ? 'signup' : 'signin'
        });
        
        google.accounts.id.renderButton(
          document.getElementById('google-btn-wrapper'),
          { theme: 'outline', size: 'large', width: '100%', text: window.location.pathname.includes('register') ? 'signup_with' : 'signin_with' }
        );
      };
    }
  } catch (e) {
    console.error("Failed to load Google Client ID", e);
  }
}

initGoogleSignIn();

// --- PASSWORD VISIBILITY TOGGLE ---
function togglePasswordVisibility(targetId, btn) {
  const input = document.getElementById(targetId || 'password');
  if (!input) return;
  const icon = (btn && btn.querySelector('i')) || document.querySelector(`[data-target="${targetId}"] i`) || document.querySelector('.password-toggle-btn i');

  if (input.type === 'password') {
    input.type = 'text';
    if (icon) {
      icon.className = 'fa-solid fa-eye-slash';
      icon.style.color = 'var(--primary-color)';
    }
  } else {
    input.type = 'password';
    if (icon) {
      icon.className = 'fa-regular fa-eye';
      icon.style.color = 'var(--text-muted)';
    }
  }
}
window.togglePasswordVisibility = togglePasswordVisibility;

function setupPasswordToggles() {
  document.querySelectorAll('.password-toggle-btn').forEach(btn => {
    btn.onclick = function(e) {
      e.preventDefault();
      const targetId = btn.getAttribute('data-target') || 'password';
      togglePasswordVisibility(targetId, btn);
    };
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupPasswordToggles);
} else {
  setupPasswordToggles();
}

