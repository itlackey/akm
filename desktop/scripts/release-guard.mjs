/** Why a build must not be distributed, or null. Desktop X embeds released akm X: one version, one release. */
export function releaseRefusal({ version, dirty, tags }) {
  if (dirty) return "The working tree has uncommitted changes. Commit them and build from the release tag.";
  if (!tags.includes(`v${version}`))
    return `HEAD is not tagged v${version}. Build distributable AppImages from the release tag.`;
  return null;
}
