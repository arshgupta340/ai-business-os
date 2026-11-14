'use client';

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {MetadataList, MetadataListItem} from '@astryxdesign/core/MetadataList';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VStack} from '@astryxdesign/core/VStack';
import {isApiError, useUpdateBusiness, type Business} from '@/lib/api';
import {formatDateTime} from '@/lib/format';
import {checkProfileInput, profileFromBusiness, sameProfile, type ProfileInput} from '../_lib/settings-model';
import {RequestError} from './RequestError';

type FieldErrors = Partial<Record<keyof ProfileInput, string>>;

/** Maps VALIDATION_FAILED issues (path, message) to the fields they name. */
function serverFieldErrors(error: unknown): FieldErrors {
  if (!isApiError(error) || error.code !== 'VALIDATION_FAILED' || !Array.isArray(error.details?.issues)) return {};
  const out: FieldErrors = {};
  for (const issue of error.details.issues as {path?: unknown; message?: unknown}[]) {
    const path = String(issue?.path ?? '');
    const field = path.replace(/^contact\./, '') as keyof ProfileInput;
    if (['name', 'phone', 'email', 'address'].includes(field) && typeof issue.message === 'string') out[field] = issue.message;
  }
  return out;
}

/**
 * Name and contact are saved with the business update call, only when the owner
 * presses Save. "Saved" shows only after the server answers. Category and time
 * zone are read-only.
 */
export function ProfileSection({businessId, business}: {businessId: string; business: Business}) {
  const update = useUpdateBusiness(businessId);
  const [saved, setSaved] = useState<ProfileInput>(() => profileFromBusiness(business));
  const [input, setInput] = useState<ProfileInput>(saved);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [savedAt, setSavedAt] = useState<string>();

  const dirty = !sameProfile(input, saved);
  const fieldErrors = {...serverFieldErrors(update.error), ...errors};
  const set = (field: keyof ProfileInput) => (value: string) => {
    setInput((prev) => ({...prev, [field]: value}));
    setErrors((prev) => ({...prev, [field]: undefined}));
    setSavedAt(undefined);
  };

  const save = () => {
    if (update.isPending) return;
    const check = checkProfileInput(input);
    if (!check.ok) return setErrors(check.errors);
    setErrors({});
    update.mutate(check.patch, {
      onSuccess: (result) => {
        const next = profileFromBusiness(result);
        setSaved(next);
        setInput(next);
        setSavedAt(result.updatedAt);
      },
    });
  };

  const status = (field: keyof ProfileInput) =>
    fieldErrors[field] ? {type: 'error' as const, message: fieldErrors[field]!} : undefined;

  return (
    <VStack gap={4}>
      <MetadataList>
        <MetadataListItem label="Category">
          <Text>{business.category}</Text>
        </MetadataListItem>
        <MetadataListItem label="Time zone">
          <Text>{business.timezone}</Text>
        </MetadataListItem>
      </MetadataList>
      <Text type="supporting">Category and time zone are set when the business is created. They cannot be changed here.</Text>
      <TextInput label="Business name" value={input.name} onChange={set('name')} status={status('name')} statusVariant="detached" isRequired isDisabled={update.isPending} />
      <TextInput label="Phone" type="tel" value={input.phone} onChange={set('phone')} status={status('phone')} statusVariant="detached" isOptional isDisabled={update.isPending} />
      <TextInput label="Email" type="email" value={input.email} onChange={set('email')} status={status('email')} statusVariant="detached" isOptional isDisabled={update.isPending} />
      <TextInput
        label="Address"
        description="The business location."
        value={input.address}
        onChange={set('address')}
        status={status('address')}
        statusVariant="detached"
        isOptional
        isDisabled={update.isPending}
      />
      {update.error && !Object.keys(serverFieldErrors(update.error)).length ? (
        <RequestError title="The profile was not saved" error={update.error} onRetry={save} />
      ) : null}
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Button label="Save" variant="primary" onClick={save} isLoading={update.isPending} isDisabled={!dirty || update.isPending} />
        {dirty && !update.isPending ? <Button label="Undo changes" variant="ghost" onClick={() => setInput(saved)} /> : null}
        {update.isPending ? <Text type="supporting">Saving</Text> : null}
        {savedAt && !dirty && !update.isPending ? (
          <Text type="supporting">{`Saved. The server confirmed it at ${formatDateTime(savedAt, business.timezone)}.`}</Text>
        ) : null}
      </HStack>
    </VStack>
  );
}
