// Click-to-zoom lightbox for Mermaid diagrams and content images (mdBook).
//
// Mermaid SVGs rely on internal references like url(#arrowhead-<id>) and
// xlink:href="#...". To avoid breaking them in the zoomed view we MOVE the
// rendered <svg> into the lightbox and put it back on close (rather than
// cloning and stripping ids).

(() => {
    'use strict';

    const LIGHTBOX_CLASS = 'cebook-lightbox';
    const INNER_CLASS = 'cebook-lightbox-inner';

    let activeRestore = null;

    function closeLightbox() {
        if (typeof activeRestore === 'function') {
            try { activeRestore(); } catch (_) { /* noop */ }
            activeRestore = null;
        }
        document.querySelectorAll('.' + LIGHTBOX_CLASS).forEach((el) => el.remove());
        document.body.style.overflow = '';
    }

    function createWrap(label) {
        const wrap = document.createElement('div');
        wrap.className = LIGHTBOX_CLASS;
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', label);

        const inner = document.createElement('div');
        inner.className = INNER_CLASS;
        inner.addEventListener('click', (e) => e.stopPropagation());
        wrap.appendChild(inner);

        const hint = document.createElement('div');
        hint.className = 'cebook-lightbox-hint';
        hint.textContent = 'Esc or outside click to close';
        inner.appendChild(hint);

        wrap.addEventListener('click', closeLightbox);
        return { wrap, inner };
    }

    function openLightboxFromMermaid(mermaidEl) {
        const svg = mermaidEl.querySelector('svg');
        if (!svg) {
            return;
        }

        const { wrap, inner } = createWrap('Diagram (enlarged)');

        // Placeholder to preserve layout space in the page while moving the SVG.
        const placeholder = document.createElement('div');
        placeholder.style.minHeight = mermaidEl.getBoundingClientRect().height + 'px';
        mermaidEl.parentNode.insertBefore(placeholder, mermaidEl);

        // Remember original sizing so we can restore it precisely.
        const originalAttrs = {
            width: svg.getAttribute('width'),
            height: svg.getAttribute('height'),
            maxWidth: svg.style.maxWidth,
            style: svg.getAttribute('style'),
        };

        // Move (not clone) the mermaid block into the lightbox so all internal
        // url(#...) references keep working.
        inner.insertBefore(mermaidEl, inner.firstChild);

        // Let the zoomed SVG fill the lightbox panel.
        svg.setAttribute('width', '100%');
        svg.removeAttribute('height');
        svg.style.maxWidth = 'none';
        svg.style.width = 'min(92vw, 1600px)';
        svg.style.height = 'auto';

        activeRestore = () => {
            // Restore SVG attrs first, then move the mermaid block back.
            if (originalAttrs.width !== null) { svg.setAttribute('width', originalAttrs.width); }
            else { svg.removeAttribute('width'); }
            if (originalAttrs.height !== null) { svg.setAttribute('height', originalAttrs.height); }
            else { svg.removeAttribute('height'); }
            if (originalAttrs.style !== null) { svg.setAttribute('style', originalAttrs.style); }
            else { svg.removeAttribute('style'); }
            svg.style.maxWidth = originalAttrs.maxWidth || '';

            if (placeholder.parentNode) {
                placeholder.parentNode.insertBefore(mermaidEl, placeholder);
                placeholder.remove();
            }
        };

        document.body.appendChild(wrap);
        document.body.style.overflow = 'hidden';
    }

    function openLightboxFromImage(img) {
        const { wrap, inner } = createWrap('Image (enlarged)');

        const full = document.createElement('img');
        full.src = img.currentSrc || img.src;
        full.alt = img.alt || '';
        if (img.srcset) {
            full.srcset = img.srcset;
            full.sizes = '96vw';
        }
        inner.insertBefore(full, inner.firstChild);

        document.body.appendChild(wrap);
        document.body.style.overflow = 'hidden';
    }

    function onContentClick(e) {
        const content = e.currentTarget;
        if (!(content instanceof HTMLElement)) {
            return;
        }

        const mermaidRoot = e.target.closest('.mermaid');
        if (mermaidRoot && content.contains(mermaidRoot) && mermaidRoot.querySelector('svg')) {
            e.preventDefault();
            e.stopPropagation();
            openLightboxFromMermaid(mermaidRoot);
            return;
        }

        const img = e.target.closest('img');
        if (!img || !content.contains(img)) {
            return;
        }

        if (img.closest('.' + LIGHTBOX_CLASS)) {
            return;
        }

        if (img.closest('#mdbook-menu-bar, #mdbook-sidebar, .sidebar')) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        openLightboxFromImage(img);
    }

    function bindContent(content) {
        if (!content || content.dataset.cebookZoomBound === '1') {
            return;
        }
        content.dataset.cebookZoomBound = '1';
        content.addEventListener('click', onContentClick);
    }

    function init() {
        bindContent(document.querySelector('.content'));
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeLightbox();
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    const existing = document.querySelector('.content');
    if (existing) {
        const observer = new MutationObserver(() => {
            bindContent(document.querySelector('.content'));
        });
        observer.observe(existing, { childList: true, subtree: true });
    }
})();
