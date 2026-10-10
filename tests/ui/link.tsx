import type { AnchorHTMLAttributes } from "react";

/** Le banc local teste le calendrier ; ses liens restent des ancres sans routeur Next.js. */
export default function Link(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />;
}
