// core/dom.js — tiny DOM helpers used everywhere instead of jQuery-style bloat.

// Query a single element within `root` (defaults to the whole document).
export function $(selector, root = document) {
  return root.querySelector(selector);
}

// Query all matching elements within `root`, returned as a real array.
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

// Escape user/data-sourced text before interpolating it into innerHTML strings.
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Build a real DOM element without a template engine: el('div', {class:'x'}, [child, 'text'])
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// Remove every child of a node without a full innerHTML re-parse.
export function empty(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}
