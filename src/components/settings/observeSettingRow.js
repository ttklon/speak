/** Ждёт строку в загружающемся разделе; возвращает функцию отмены. */
export function observeSettingRow(root, title, onFound) {
  const query = title.toLowerCase();
  let observer;
  const find = () => {
    const row = [...root.querySelectorAll('.setting-row')].find((item) =>
      item.textContent.toLowerCase().includes(query),
    );
    if (!row) return;
    observer.disconnect();
    onFound(row);
  };
  observer = new MutationObserver(find);
  observer.observe(root, { childList: true, subtree: true });
  find();
  return () => observer.disconnect();
}
