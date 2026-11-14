'use client';

import {useRouter} from 'next/navigation';
import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {useAuth} from '@/lib/session/auth';

export function OwnerControls() {
  const {owner, status, signOut} = useAuth();
  const router = useRouter();
  if (status !== 'signed_in' || !owner) {
    return null;
  }
  return (
    <HStack gap={2} vAlign="center">
      <Text type="supporting">{owner.displayName}</Text>
      <Button
        label="Sign out"
        variant="ghost"
        size="sm"
        clickAction={async () => {
          await signOut();
          router.replace('/sign-in');
        }}
      />
    </HStack>
  );
}
