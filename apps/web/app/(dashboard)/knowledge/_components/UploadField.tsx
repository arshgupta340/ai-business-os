'use client';

import {useState} from 'react';
import {FileInput} from '@astryxdesign/core/FileInput';
import {VStack} from '@astryxdesign/core/VStack';
import {useUploadFile} from '@/lib/api';
import {ApiErrorBanner} from './ApiErrorBanner';
import {checkUpload} from './knowledge-model';

type Props = {
  businessId: string;
  onUploaded: (fileId: string) => void;
  label?: string;
  mode?: 'input' | 'dropzone';
};

/**
 * Picks or takes a dropped file, checks its type and the 10 MB cap in the
 * browser, then sends it. The server checks the same rule, and its error is
 * shown as well.
 */
export function UploadField({businessId, onUploaded, label = 'Upload a document', mode = 'dropzone'}: Props) {
  const upload = useUploadFile(businessId);
  const [value, setValue] = useState<File | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const onChange = (files: File | File[] | null) => {
    const file = Array.isArray(files) ? (files[0] ?? null) : files;
    upload.reset();
    if (!file) {
      setValue(null);
      setRefusal(null);
      return;
    }
    const check = checkUpload(file);
    if (!check.ok) {
      setValue(null);
      setRefusal(check.message);
      return;
    }
    setRefusal(null);
    setValue(file);
    // A file with no type from the browser gets the type its extension names.
    const blob = file.type ? file : new File([file], file.name, {type: check.mime});
    upload.mutate(
      {file: blob, fileName: file.name},
      {
        onSuccess: (record) => {
          setValue(null);
          onUploaded(record.id);
        },
        onError: () => setValue(null),
      },
    );
  };

  return (
    <VStack gap={3}>
      <FileInput
        label={label}
        mode={mode}
        value={value}
        onChange={onChange}
        isLoading={upload.isPending}
        isDisabled={upload.isPending}
        placeholder="Choose a file or drop it here"
        description="PDF, image (PNG, JPEG, WebP), CSV or spreadsheet (.xlsx), up to 10 MB."
        status={refusal ? {type: 'error', message: refusal} : undefined}
      />
      {upload.error ? <ApiErrorBanner title="The file was not uploaded" error={upload.error} /> : null}
    </VStack>
  );
}
