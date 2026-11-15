'use client';

import {useRouter} from 'next/navigation';
import {Avatar} from '@astryxdesign/core/Avatar';
import {Button} from '@astryxdesign/core/Button';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {useAuth} from '@/lib/session/auth';

/** The profile circle in the top bar, with the owner's initials. Its menu shows who is signed in and has Sign out. */
export function OwnerControls() {
  const {owner, status, signOut} = useAuth();
  const router = useRouter();
  if (status !== 'signed_in' || !owner) {
    return null;
  }
  return (
    <DropdownMenu
      alignment="end"
      header={
        <VStack gap={0}>
          <Text type="body" weight="semibold">
            {owner.displayName}
          </Text>
          {owner.email && owner.email !== owner.displayName ? <Text type="supporting">{owner.email}</Text> : null}
        </VStack>
      }
      renderTrigger={(props) => (
        <Button label="Account" variant="ghost" size="sm" isIconOnly {...props}>
          <Avatar name={owner.displayName} size="md" />
        </Button>
      )}
      items={[
        {
          id: 'sign-out',
          label: 'Sign out',
          onClick: () => {
            void signOut().then(() => router.replace('/sign-in'));
          },
        },
      ]}
    />
  );
}
