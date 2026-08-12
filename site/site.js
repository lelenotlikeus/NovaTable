const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const glow = document.querySelector(".cursor-light");
const meter = document.querySelector(".scroll-meter");

addEventListener("pointermove", (event) => {
  glow?.style.setProperty("--x", `${event.clientX}px`); glow?.style.setProperty("--y", `${event.clientY}px`);
});

document.querySelectorAll("[data-tilt]").forEach((element) => {
  element.addEventListener("pointermove", (event) => { if (reduceMotion) return; const bounds = element.getBoundingClientRect(); element.style.setProperty("--ry", `${((event.clientX - bounds.left) / bounds.width - .5) * 12}deg`); element.style.setProperty("--rx", `${((event.clientY - bounds.top) / bounds.height - .5) * -9}deg`); });
  element.addEventListener("pointerleave", () => { element.style.setProperty("--rx", "0deg"); element.style.setProperty("--ry", "0deg"); });
});
document.querySelectorAll("[data-card-tilt]").forEach((card) => {
  card.addEventListener("pointermove", (event) => {
    if (reduceMotion || innerWidth < 900) return;
    const bounds = card.getBoundingClientRect(); const x = (event.clientX - bounds.left) / bounds.width - .5; const y = (event.clientY - bounds.top) / bounds.height - .5;
    card.style.transform = `perspective(1100px) rotateX(${y * -6}deg) rotateY(${x * 7}deg) translateY(-7px)`;
    card.style.setProperty("--spot-x", `${(x + .5) * 100}%`); card.style.setProperty("--spot-y", `${(y + .5) * 100}%`);
  });
  card.addEventListener("pointerleave", () => { card.style.transform = ""; });
});
document.querySelectorAll(".magnetic").forEach((element) => {
  element.addEventListener("pointermove", (event) => { if (reduceMotion) return; const bounds = element.getBoundingClientRect(); element.style.transform = `translate(${(event.clientX - bounds.left - bounds.width / 2) * .12}px,${(event.clientY - bounds.top - bounds.height / 2) * .12}px)`; });
  element.addEventListener("pointerleave", () => { element.style.transform = ""; });
});

const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) entry.target.classList.add("is-visible"); }), { threshold: .12 });
document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
addEventListener("scroll", () => { const max = document.documentElement.scrollHeight - innerHeight; meter.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`; }, { passive: true });
