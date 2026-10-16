import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.48.1';

interface InvitePayload {
  email: string;
  role: 'admin' | 'clerk';
  displayNameEnc?: string;
  permissions?: string[];
}

const DEFAULT_CLERK_PERMISSIONS = [
  'create_booking',
  'enter_guest_details',
  'view_reports',
  'deny_request'
];

serve(async (req: Request) => {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    // Verify caller credentials using anon client + auth header
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const {
      data: { user: callerUser },
      error: authError
    } = await userClient.auth.getUser();

    if (authError || !callerUser) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Service role admin client
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Verify caller is an active admin (with AAL2 MFA when app_config.require_mfa is on)
    const { data: callerProfile, error: profileError } = await adminClient
      .from('profiles')
      .select('role, is_active')
      .eq('id', callerUser.id)
      .single();

    if (profileError || !callerProfile || !callerProfile.is_active || callerProfile.role !== 'admin') {
      return new Response(
        JSON.stringify({ error: 'Forbidden: Caller must be an active Administrator' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // getUser() already verified the token signature, so the payload can be read directly.
    let callerAal: string | undefined;
    try {
      const payload = authHeader.replace(/^Bearer\s+/i, '').split('.')[1];
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      callerAal = JSON.parse(json).aal;
    } catch {
      callerAal = undefined;
    }
    const { data: mfaRequired } = await adminClient.rpc('mfa_required');
    if (mfaRequired !== false && callerAal !== 'aal2') {
      return new Response(
        JSON.stringify({ error: 'Forbidden: MFA (AAL2) session required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate request body
    const body: InvitePayload = await req.json();
    const email = body.email?.trim().toLowerCase();
    const role = body.role || 'clerk';

    if (!email || !email.includes('@')) {
      return new Response(JSON.stringify({ error: 'Invalid email address' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 1. Invite user via Supabase Auth Admin API
    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email);
    if (inviteError || !inviteData?.user) {
      return new Response(JSON.stringify({ error: inviteError?.message || 'Failed to send invite' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const newUserId = inviteData.user.id;
    const permissions =
      role === 'admin'
        ? [
            'create_booking',
            'enter_guest_details',
            'reveal_guest_pii',
            'cancel_booking',
            'approve_eviction',
            'view_reports',
            'deny_request'
          ]
        : body.permissions || DEFAULT_CLERK_PERMISSIONS;

    // 2. Insert profile record
    const { error: insertProfileError } = await adminClient.from('profiles').insert({
      id: newUserId,
      role,
      permissions,
      display_name_enc: body.displayNameEnc || null,
      is_active: true
    });

    if (insertProfileError) {
      return new Response(JSON.stringify({ error: insertProfileError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. Write immutable audit log event (service role has no AAL2 session, so use
    // the internal helper directly; log_event would reject it)
    await adminClient.rpc('log_audit_event', {
      p_action: 'user_invited',
      p_entity: 'profiles',
      p_entity_id: newUserId,
      p_meta: {
        invited_role: role,
        invited_by: callerUser.id
      }
    });

    return new Response(
      JSON.stringify({
        success: true,
        userId: newUserId,
        email,
        role
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
