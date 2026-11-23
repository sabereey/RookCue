const controls = document.querySelector(".demo-controls");
const steps = [...controls.querySelectorAll("button")];
const panels = steps.map((step) => document.getElementById(step.getAttribute("aria-controls")));

function showStep(index) {
  steps.forEach((step, position) => {
    const selected = position === index;
    step.setAttribute("aria-pressed", String(selected));
    panels[position].hidden = !selected;
  });
}

steps.forEach((step, index) => {
  step.addEventListener("click", () => showStep(index));
});

showStep(0);
controls.hidden = false;
