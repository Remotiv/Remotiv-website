"use client";

import Image from "next/image";
import { useState } from "react";

/**
 * Crossfade photo loader.
 *
 * Renders a grey skeleton circle while the underlying <Image>
 * loads, then crossfades the photo in. If the image fails to load
 * (404, malformed URL), calls onError so the parent can render
 * its initials fallback.
 *
 * IMPORTANT: parent should already have decided photoUrl is
 * non-null. This component does NOT render an initials fallback
 * itself — the parent owns that JSX so each surface can keep its
 * own visual identity (role-colored squircle, hash-colored circle,
 * gradient drawer avatar, etc.).
 *
 * Used by /browse-talent modal, /hire-remote list card, and
 * /hire-remote drawer.
 */
export function LazyPhoto({
  src,
  alt,
  size,
  className = "",
  rounded = "full",
  onError,
}: {
  src: string;
  alt: string;
  size: number;
  className?: string;
  rounded?: "full" | "2xl" | "lg";
  onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const radiusClass =
    rounded === "full"
      ? "rounded-full"
      : rounded === "2xl"
        ? "rounded-2xl"
        : "rounded-lg";

  return (
    <span
      className={`relative inline-block shrink-0 overflow-hidden ${radiusClass} ${className}`}
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-0 ${radiusClass} bg-gray-200 transition-opacity duration-200 ${
          loaded ? "opacity-0" : "opacity-100"
        }`}
      />
      <Image
        src={src}
        alt={alt}
        fill
        sizes={`${size}px`}
        className={`object-cover transition-opacity duration-300 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        onLoad={() => setLoaded(true)}
        onError={onError}
      />
    </span>
  );
}
