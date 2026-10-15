import { BRAND } from "../brand.js";

// About screen content. Aurelle is a fork of Songbird (MIT), so the original
// authorship stays credited here and in LICENSE.
export const ABOUT_CONTENT = {
  copyright: {
    ownerLabel: BRAND.name,
    ownerHref: BRAND.repository,
  },
  socials: [
    {
      icon: "github",
      href: BRAND.repository,
    },
  ],
  upstream: {
    label: `${BRAND.upstream.name} by @bllackbull`,
    href: BRAND.upstream.repository,
  },
  // No donation wallets: the ones that shipped with the original project
  // belong to its author, not to this fork. Add your own here if wanted.
  supportIntro: "",
  donationLink: null,
  wallets: [],
};
