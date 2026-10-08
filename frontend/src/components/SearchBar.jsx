import React, { useRef, useState } from 'react';
import { Search, Link as LinkIcon, Sparkles, ArrowRight, Camera, X } from 'lucide-react';

const MAX_IMAGE_SIDE = 800;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Downscale a picked photo in the browser and return it as a JPEG data URL. */
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}

export default function SearchBar({ onSearch, isLoading, compact = false }) {
  const [inputVal, setInputVal] = useState('');
  const [image, setImage] = useState(null); // { dataUrl, name }
  const [imageError, setImageError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);

  const sampleQueries = [
    { label: 'Oversized Graphic Tee', query: 'oversized graphic tee' },
    { label: 'Protein Dark Chocolate', query: 'protein dark chocolate' },
    { label: 'Minimalist Leather Backpack', query: 'minimalist leather backpack' },
    { label: 'Wireless Noise Canceling Headphones', query: 'wireless noise canceling headphones' },
    { label: 'Shopify / Brand URL', query: 'https://gymshark.com/products/crest-hoodie-black' },
  ];

  const pickImage = async (file) => {
    setImageError('');
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setImageError('Use a JPEG, PNG or WebP photo.');
      return;
    }
    try {
      setImage({ dataUrl: await downscaleImage(file), name: file.name });
    } catch (err) {
      setImageError(err.message);
    }
  };

  const clearImage = () => {
    setImage(null);
    setImageError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const canSubmit = (inputVal.trim() || image) && !isLoading;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSearch(inputVal.trim(), image?.dataUrl);
  };

  const handleSelectSample = (query) => {
    setInputVal(query);
    clearImage();
    onSearch(query);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (!isLoading) pickImage(e.dataTransfer.files?.[0]);
  };

  const isUrl = /^https?:\/\//i.test(inputVal.trim());
  const placeholder = image
    ? 'Optional: add a product name to guide the search...'
    : "Type a product name, paste a product URL, or upload a photo...";

  return (
    <section className={`search-section ${compact ? 'search-section--compact' : ''}`}>
      <form onSubmit={handleSubmit} className="search-bar">
        <div
          className={`search-bar__input-wrapper ${dragging ? 'search-bar__input-wrapper--drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <div className="search-bar__icon">
            {isUrl ? <LinkIcon size={20} className="text-accent" /> : <Search size={20} />}
          </div>

          {image && (
            <span className="search-bar__image" title={image.name}>
              <img src={image.dataUrl} alt="Uploaded product" />
              <button type="button" onClick={clearImage} aria-label="Remove photo" disabled={isLoading}>
                <X size={12} />
              </button>
            </span>
          )}

          <input
            type="text"
            className="search-bar__input"
            placeholder={placeholder}
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            disabled={isLoading}
          />

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            hidden
            onChange={(e) => pickImage(e.target.files?.[0])}
          />
          <button
            type="button"
            className="search-bar__upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            title="Upload a product photo"
            aria-label="Upload a product photo"
          >
            <Camera size={18} />
          </button>

          <button type="submit" className="search-bar__btn" disabled={!canSubmit}>
            {isLoading ? (
              <>
                <span className="spinner" />
                <span>Searching...</span>
              </>
            ) : (
              <>
                <span>Discover</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </div>

        {imageError && <p className="search-bar__error">{imageError}</p>}

        {!compact && (
          <div className="search-bar__hint" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-secondary)' }}>
              <Sparkles size={14} style={{ color: 'var(--accent-secondary)' }} />
              Quick Try:
            </span>
            {sampleQueries.map((item, idx) => (
              <button
                key={idx}
                type="button"
                className="btn btn--ghost"
                style={{ padding: '4px 10px', fontSize: '0.75rem', borderRadius: 'var(--radius-full)' }}
                onClick={() => handleSelectSample(item.query)}
                disabled={isLoading}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </form>
    </section>
  );
}
