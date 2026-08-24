/**
 * Centralizes file operation mutations, query invalidation, and selection sync.
 * All file management UI surfaces delegate to this hook.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getApiErrorMessage } from '@/lib/api-error';
import { withBasePath } from '@/base-path';
import {
  filesCreateFileMutation,
  filesCreateDirectoryMutation,
  filesRenamePathMutation,
  filesCopyPathMutation,
  filesMovePathMutation,
  filesDeletePathMutation,
  filesReadTreeQueryKey,
  filesReadFileQueryKey,
  filesGetMetadataQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { clearApiToken, getAuthorizationHeader } from '@/auth-token';

interface UploadFilesResponse {
  files: Array<{ path: string; size: number }>;
}

interface UploadFilesVariables {
  destinationPath: string;
  formData: FormData;
}

/** Invalidates the tree query for a specific directory. */
function treeKey(dir: string) {
  return filesReadTreeQueryKey({ query: { root: dir } });
}

/** Extracts parent directory from a path. */
function parentDir(filePath: string): string {
  return filePath.substring(0, filePath.lastIndexOf('/')) || '/';
}

/** Remaps selected descendants after a directory rename or move. */
function remapSelectedPath(
  selectedFile: string | null,
  oldPath?: string,
  newPath?: string,
): string | null {
  if (!selectedFile || !oldPath || !newPath) return null;
  if (selectedFile === oldPath) return newPath;
  if (selectedFile.startsWith(`${oldPath}/`)) {
    return `${newPath}${selectedFile.slice(oldPath.length)}`;
  }
  return null;
}

/** Returns auth headers for direct fetch calls that bypass the generated client. */
function authHeaders(): HeadersInit {
  const authorization = getAuthorizationHeader();
  return authorization ? { Authorization: authorization } : {};
}

/** Mirrors the generated API client's auth-expiry behavior for direct fetch calls. */
function handleUnauthorized(status: number): void {
  if (status !== 401) return;
  clearApiToken();
  window.dispatchEvent(new Event('codex-webui:auth-expired'));
}

/** Extracts and translates the API error from direct fetch responses. */
function readApiError(errorBody: unknown, fallback: string): string {
  return getApiErrorMessage(errorBody, fallback);
}

export function useFileOperations() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const selectFile = useFilesStore((s) => s.selectFile);
  const selectedFile = useFilesStore((s) => s.selectedFile);

  /** Invalidates tree queries for one or more parent directories. */
  const invalidateDirs = (...dirs: string[]) => {
    const unique = [...new Set(dirs)];
    for (const dir of unique) {
      void queryClient.invalidateQueries({ queryKey: treeKey(dir) });
    }
  };

  const createFile = useMutation({
    ...filesCreateFileMutation(),
    onSuccess: (_res, variables) => {
      const dir = parentDir(variables.body!.path);
      invalidateDirs(dir);
      showSnackbar(t('File created'), 'success');
    },
  });

  const createDirectory = useMutation({
    ...filesCreateDirectoryMutation(),
    onSuccess: (_res, variables) => {
      const dir = parentDir(variables.body!.path);
      invalidateDirs(dir);
      showSnackbar(t('Directory created'), 'success');
    },
  });

  const renamePath = useMutation({
    ...filesRenamePathMutation(),
    onSuccess: (res, variables) => {
      const dir = parentDir(variables.body!.path);
      invalidateDirs(dir);
      const nextSelected = remapSelectedPath(selectedFile, res.oldPath, res.newPath);
      if (nextSelected) {
        selectFile(nextSelected);
      }
      showSnackbar(t('Renamed successfully'), 'success');
    },
  });

  const copyPath = useMutation({
    ...filesCopyPathMutation(),
    onSuccess: (_res, variables) => {
      const destDir = parentDir(variables.body!.destinationPath);
      invalidateDirs(destDir);
      showSnackbar(t('Copied successfully'), 'success');
    },
  });

  const movePath = useMutation({
    ...filesMovePathMutation(),
    onSuccess: (res, variables) => {
      const srcDir = parentDir(variables.body!.sourcePath);
      const destDir = parentDir(variables.body!.destinationPath);
      invalidateDirs(srcDir, destDir);
      const nextSelected = remapSelectedPath(selectedFile, res.oldPath, res.newPath);
      if (nextSelected) {
        selectFile(nextSelected);
      }
      showSnackbar(t('Moved successfully'), 'success');
    },
  });

  const deletePath = useMutation({
    ...filesDeletePathMutation(),
    onSuccess: (_res, variables) => {
      const deleted = variables.query!.path;
      const dir = parentDir(deleted);
      invalidateDirs(dir);
      if (
        selectedFile === deleted ||
        selectedFile?.startsWith(`${deleted}/`)
      ) {
        selectFile(null);
      }
      showSnackbar(t('Deleted successfully'), 'success');
    },
  });

  /** Upload via direct fetch — SDK serializes body as JSON, multipart needs raw FormData. */
  const uploadFiles = useMutation<UploadFilesResponse, Error, UploadFilesVariables>({
    mutationFn: async ({ destinationPath, formData }) => {
      const resp = await fetch(
        `${withBasePath('/api/files/upload')}?destinationPath=${encodeURIComponent(destinationPath)}`,
        {
          method: 'POST',
          headers: authHeaders(),
          body: formData,
        },
      );
      if (!resp.ok) {
        handleUnauthorized(resp.status);
        const err = await resp.json().catch(() => undefined);
        throw new Error(
          readApiError(err, `${t('Upload failed')}: ${resp.status}`),
        );
      }
      return (await resp.json()) as UploadFilesResponse;
    },
    onSuccess: (res, variables) => {
      invalidateDirs(
        variables.destinationPath,
        ...res.files.map((file) => parentDir(file.path)),
      );
      showSnackbar(t('Upload complete'), 'success');
    },
    onError: (err: Error) => {
      showSnackbar(getApiErrorMessage(err, t('Upload failed')), 'error');
    },
  });

  /** Triggers a browser file download via authenticated fetch. */
  const downloadFile = async (filePath: string) => {
    try {
      const resp = await fetch(
        `${withBasePath('/api/files/download')}?path=${encodeURIComponent(filePath)}`,
        { headers: authHeaders() },
      );
      if (!resp.ok) {
        handleUnauthorized(resp.status);
        throw new Error(`Download failed: ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filePath.split('/').pop() ?? 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      showSnackbar(t('Download failed'), 'error');
    }
  };

  /** Refreshes tree for a directory or file queries for a file. */
  const refresh = (entryPath: string, type: 'file' | 'directory') => {
    if (type === 'directory') {
      invalidateDirs(entryPath);
    } else {
      void queryClient.invalidateQueries({
        queryKey: filesReadFileQueryKey({ query: { path: entryPath } }),
      });
      void queryClient.invalidateQueries({
        queryKey: filesGetMetadataQueryKey({ query: { path: entryPath } }),
      });
    }
  };

  return {
    createFile,
    createDirectory,
    renamePath,
    copyPath,
    movePath,
    deletePath,
    uploadFiles,
    downloadFile,
    refresh,
  };
}
