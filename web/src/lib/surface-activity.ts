/** Visibility is shared with portalled controls, which do not inherit a hidden surface's DOM state. */
import { createContext } from 'react';

export const SurfaceActivityContext = createContext(true);
