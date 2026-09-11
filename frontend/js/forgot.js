const API_URL = `${window.location.origin}/api`;

const forgotForm = document.getElementById('forgot-form');
const resetForm = document.getElementById('reset-form');

if (forgotForm) {
  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value;
    const msg = document.getElementById('forgot-msg');
    const errMsg = document.getElementById('forgot-error-msg');
    
    msg.style.display = 'none';
    errMsg.style.display = 'none';
    const btn = e.target.querySelector('button');
    btn.innerText = 'Sending...';
    btn.disabled = true;

    try {
      const res = await fetch(`${API_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      
      btn.innerText = 'Send Reset Link';
      btn.disabled = false;

      if (!res.ok) {
        errMsg.innerText = (data.error || 'Failed to send reset link.').replace(/\s*via\s+EmailJS\.?/gi, '.').trim();
        errMsg.style.display = 'block';
      } else {
        const cleanMsg = (data.message || 'Password reset link sent to your email.').replace(/\s*via\s+EmailJS\.?/gi, '.').trim();
        msg.innerText = cleanMsg;
        msg.style.display = 'block';
        forgotForm.reset();
      }
    } catch (err) {
      btn.innerText = 'Send Reset Link';
      btn.disabled = false;
      errMsg.innerText = "Network error. Is the server running?";
      errMsg.style.display = 'block';
    }
  });
}

if (resetForm) {
  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPassword = document.getElementById('new-password').value;
    const msg = document.getElementById('reset-msg');
    const errMsg = document.getElementById('reset-error-msg');
    
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    if (!token) {
      errMsg.innerText = "Invalid or missing token! Did you copy the full link from your email?";
      errMsg.style.display = 'block';
      return;
    }

    msg.style.display = 'none';
    errMsg.style.display = 'none';
    const btn = e.target.querySelector('button');
    btn.innerText = 'Updating...';
    btn.disabled = true;

    try {
      const res = await fetch(`${API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword })
      });
      const data = await res.json();
      
      if (!res.ok) {
        errMsg.innerText = (data.error || 'Failed to update password.').replace(/\s*via\s+EmailJS\.?/gi, '.').trim();
        errMsg.style.display = 'block';
        btn.innerText = 'Update Password';
        btn.disabled = false;
      } else {
        const cleanMsg = (data.message || 'Password updated successfully').replace(/\s*via\s+EmailJS\.?/gi, '.').trim();
        msg.innerText = cleanMsg + ". Redirecting to login...";
        msg.style.display = 'block';
        resetForm.reset();
        setTimeout(() => window.location.href = 'login.html', 2000);
      }
    } catch (err) {
      errMsg.innerText = "Network error.";
      errMsg.style.display = 'block';
      btn.innerText = 'Update Password';
      btn.disabled = false;
    }
  });
}
