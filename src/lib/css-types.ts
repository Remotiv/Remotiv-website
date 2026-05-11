import type { CSSProperties } from "react";

/**
 * Extends React.CSSProperties to allow inline CSS custom properties
 * (e.g. style={{ "--card-top": "12px" }}) without needing `as string` casts.
 */
export type CSSPropertiesWithVars = CSSProperties & Record<`--${string}`, string | number>;
