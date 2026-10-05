// Which build of the app this is, and when it was made. The deploy (.github/workflows/pages.yml) replaces the two placeholders with the
// short commit id and the date; a copy run straight from the repository keeps them and shows as a development copy.
export const APP_BUILD = "__BUILD__";
export const APP_BUILT_ON = "__BUILT_ON__";
export const isDevBuild = () => APP_BUILD.startsWith("__");
