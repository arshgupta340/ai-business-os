'use client';

import {useRouter} from 'next/navigation';
import {Avatar} from '@astryxdesign/core/Avatar';
import {Button} from '@astryxdesign/core/Button';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {withBasePath} from '@/lib/env';
import {useAuth} from '@/lib/session/auth';

/**
 * The picture in the profile circle: `public/owner-avatar.jpg`, a generated
 * face of a person who does not exist. If the file fails to load, the circle
 * shows the owner's initials.
 */
export const OWNER_AVATAR_SRC = withBasePath('/owner-avatar.jpg');

/** The profile circle in the top bar. Its menu shows who is signed in and has Sign out. */
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
        <Button label="Account" variant="ghost" isIconOnly icon={<Avatar name={owner.displayName} src={OWNER_AVATAR_SRC} size="md" />} {...props} />
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
