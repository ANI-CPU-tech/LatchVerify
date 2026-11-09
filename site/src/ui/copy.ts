/**
 * Copy buttons: [data-copy="<id>"] copies the text of the element with that id, as the page shows
 * it at that moment (the download fields may have been refreshed since the page loaded). A status
 * line tells screen readers; where the clipboard is unavailable the text is selected instead.
 */
export function initCopy(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-copy]");
  if (buttons.length === 0) return;
  const status = document.createElement("p");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  document.body.append(status);

  for (const button of buttons) {
    let timer: number | undefined;
    button.addEventListener("click", async () => {
      const source = document.getElementById(button.dataset.copy ?? "");
      const text = source?.textContent?.trim();
      if (!source || !text) return;
      try {
        await navigator.clipboard.writeText(text);
        button.classList.add("is-copied");
        status.textContent = "Copied to the clipboard";
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          button.classList.remove("is-copied");
          status.textContent = "";
        }, 1600);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        status.textContent = "Selected; press Ctrl+C or Cmd+C to copy";
      }
    });
  }
}
