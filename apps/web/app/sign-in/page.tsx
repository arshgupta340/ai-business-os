'use client';

// Adapted from the Astryx page template "login"
// (npx @astryxdesign/cli template login). Layout and spacing are kept.
// The heroicons logo was removed.

import {useEffect, useState, type CSSProperties, type SyntheticEvent} from 'react';
import {useRouter} from 'next/navigation';
import {VStack} from '@astryxdesign/core/Layout';
import {Center} from '@astryxdesign/core/Center';
import {Text, Heading} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Banner} from '@astryxdesign/core/Banner';
import {LoadingState} from '@/components/LoadingState';
import {useAuth} from '@/lib/session/auth';

// Standalone auth page paints its own body background (no host shell).
const pageStyle: CSSProperties = {
  minHeight: '100%',
  backgroundColor: 'var(--color-background-body)',
};
// Cap the column at 400px but let it shrink to fit narrow screens.
const contentStyle: CSSProperties = {
  width: '100%',
  maxWidth: 400,
};

export default function SignInPage() {
  const {status, signIn, isMock, configError} = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Guard: signed-in owners leave this page.
  useEffect(() => {
    if (status === 'signed_in') {
      router.replace('/overview');
    }
  }, [status, router]);

  const submit = async () => {
    setError('');
    if (!isMock && (!email || !password)) {
      setError('Enter both your email and your password.');
      return;
    }
    setIsSubmitting(true);
    const result = await signIn(email, password);
    setIsSubmitting(false);
    if (!result.ok) {
      setError(result.message);
    }
  };

  const handleSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    void submit();
  };

  const isBlocked = !isMock && configError !== null;

  return (
    <Center axis="both" padding={6} style={pageStyle}>
      <VStack gap={4} hAlign="center" style={contentStyle}>
        <VStack gap={2} hAlign="center">
          <Text type="body" weight="bold" size="lg">
            AI Business OS
          </Text>
        </VStack>

        <Card padding={8} width="100%">
          <VStack as="form" gap={4} hAlign="stretch" onSubmit={handleSubmit}>
            <VStack gap={1} hAlign="center">
              <Heading level={1}>Sign in</Heading>
              <Text type="body" color="secondary" size="sm">
                Sign in as the business owner.
              </Text>
            </VStack>

            {isMock ? (
              <Banner
                status="info"
                title="Mock mode"
                description="No network calls are made. Any email and password sign you in as the demo owner."
                container="card"
                collapsible={false}
              />
            ) : null}

            {isBlocked ? (
              <Banner status="error" title="Configuration error" description={configError ?? undefined} container="card" collapsible={false} />
            ) : null}

            {error ? <Banner status="error" title={error} container="card" collapsible={false} /> : null}

            {status === 'loading' ? (
              <LoadingState label="Checking sign-in" />
            ) : (
              <>
                <TextInput
                  label="Email"
                  value={email}
                  onChange={setEmail}
                  placeholder="you@example.com"
                  type="email"
                  size="lg"
                  isDisabled={isBlocked}
                />

                <TextInput
                  label="Password"
                  value={password}
                  onChange={setPassword}
                  placeholder="Enter your password"
                  type="password"
                  size="lg"
                  isDisabled={isBlocked}
                />

                <Button
                  label="Sign in"
                  type="submit"
                  variant="primary"
                  size="lg"
                  isLoading={isSubmitting}
                  isDisabled={isBlocked}
                />

                {isMock ? (
                  <Button
                    label="Continue as demo owner"
                    variant="secondary"
                    size="lg"
                    isDisabled={isSubmitting}
                    onClick={() => void submit()}
                  />
                ) : null}
              </>
            )}
          </VStack>
        </Card>
      </VStack>
    </Center>
  );
}
