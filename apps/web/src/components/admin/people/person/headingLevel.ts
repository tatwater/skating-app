import { createContext, useContext } from 'react';

/**
 * The level the person page's blocks take (*Can do*, *History*…): one under the person's name when
 * the page draws it (the name is the page's `h2`, under the list's `h1`), else straight under the
 * list's `h1` — so the outline never skips a level, whichever state the page is in.
 */
export const SectionLevel = createContext<2 | 3>(2);

export const useSectionLevel = () => useContext(SectionLevel);
