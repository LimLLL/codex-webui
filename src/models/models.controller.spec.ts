/** Hidden-model query forwarding is independent of catalog replacement. */
import { ModelsController } from './models.controller';
import type { ModelsService } from './models.service';

describe('ModelsController', () => {
  it.each([true, false, undefined])(
    'forwards includeHidden=%s with pagination',
    async (includeHidden) => {
      const listModels = vi
        .fn()
        .mockResolvedValue({ data: [], nextCursor: null });
      const controller = new ModelsController({
        listModels,
      } as unknown as ModelsService);
      await controller.listModels('cursor', '25', includeHidden);
      expect(listModels).toHaveBeenCalledWith({
        cursor: 'cursor',
        limit: 25,
        includeHidden,
      });
    },
  );
});
