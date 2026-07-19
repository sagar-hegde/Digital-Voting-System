
document.addEventListener('DOMContentLoaded', () => {

  // ── Animated counters in stats bar ──────────────────────────
  const counters = document.querySelectorAll('.stat-num[data-target]');

  const animateCounter = (el) => {
    const target = parseInt(el.dataset.target, 10);
    const duration = 1800;
    const step = 16;
    const totalSteps = duration / step;
    const increment = target / totalSteps;
    let current = 0;

    const timer = setInterval(() => {
      current += increment;
      if (current >= target) {
        el.textContent = target.toLocaleString();
        clearInterval(timer);
      } else {
        el.textContent = Math.floor(current).toLocaleString();
      }
    }, step);
  };

  // Use IntersectionObserver to trigger counters when visible
  const statsObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        counters.forEach(animateCounter);
        statsObserver.disconnect();
      }
    });
  }, { threshold: 0.3 });

  const statsBar = document.querySelector('.stats-bar');
  if (statsBar) statsObserver.observe(statsBar);


  // ── Card hover: subtle icon pulse ───────────────────────────
  const cards = document.querySelectorAll('.role-card');
  cards.forEach(card => {
    const icon = card.querySelector('.card-icon');
    card.addEventListener('mouseenter', () => {
      if (icon) {
        icon.style.transform = 'scale(1.15)';
        icon.style.transition = 'transform 0.25s ease';
      }
    });
    card.addEventListener('mouseleave', () => {
      if (icon) {
        icon.style.transform = 'scale(1)';
      }
    });
  });


  // ── Role card click ripple ───────────────────────────────────
  cards.forEach(card => {
    card.addEventListener('click', (e) => {
      const ripple = document.createElement('div');
      const rect = card.getBoundingClientRect();
      ripple.style.cssText = `
        position: absolute;
        width: 8px; height: 8px;
        border-radius: 50%;
        background: rgba(255,255,255,0.15);
        top: ${e.clientY - rect.top - 4}px;
        left: ${e.clientX - rect.left - 4}px;
        transform: scale(0);
        animation: rippleOut 0.5s ease forwards;
        pointer-events: none;
        z-index: 10;
      `;
      card.appendChild(ripple);
      setTimeout(() => ripple.remove(), 500);
    });
  });

  // Inject ripple keyframes
  const style = document.createElement('style');
  style.textContent = `
    @keyframes rippleOut {
      to { transform: scale(50); opacity: 0; }
    }
  `;
  document.head.appendChild(style);


  // ── Active role highlight on selection ──────────────────────
  // Highlight when user clicks a role button (before navigation)
  const btns = document.querySelectorAll('.card-btn');
  btns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Store selected role in sessionStorage for login pages to read
      const card = btn.closest('.role-card');
      const title = card.querySelector('.card-title')?.textContent?.toLowerCase();
      if (title) sessionStorage.setItem('selectedRole', title);
    });
  });
});

document.addEventListener("contextmenu", e => e.preventDefault());

document.addEventListener("keydown", e => {
  if (e.key === "F12") e.preventDefault();
});