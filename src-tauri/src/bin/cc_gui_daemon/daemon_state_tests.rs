use super::*;
use std::{cell::RefCell, rc::Rc};

fn codex_summary(session_id: &str, timestamp: i64) -> crate::types::LocalUsageSessionSummary {
    crate::types::LocalUsageSessionSummary {
        session_id: session_id.to_string(),
        timestamp,
        cwd: Some("/repo".to_string()),
        model: "gpt-5".to_string(),
        summary: Some(format!("Session {session_id}")),
        ..Default::default()
    }
}

#[test]
fn daemon_codex_local_thread_response_marks_live_unavailable() {
    let sessions = vec![codex_summary("s1", 20), codex_summary("s2", 10)];
    let response =
        build_codex_daemon_local_thread_response("/repo", sessions, None, Some(1), &HashMap::new());
    let result = response.get("result").and_then(Value::as_object).unwrap();
    let data = result.get("data").and_then(Value::as_array).unwrap();

    assert_eq!(
        result.get("partialSource").and_then(Value::as_str),
        Some(CODEX_DAEMON_LOCAL_THREAD_LIST_PARTIAL_SOURCE)
    );
    assert_eq!(data.len(), 1);
    assert_eq!(data[0].get("id").and_then(Value::as_str), Some("s1"));
    assert_eq!(
        data[0].get("partialSource").and_then(Value::as_str),
        Some(CODEX_DAEMON_LOCAL_THREAD_LIST_PARTIAL_SOURCE)
    );
    assert_eq!(
        result.get("nextCursor").and_then(Value::as_str),
        Some("codex-daemon-local:1")
    );
}

#[test]
fn daemon_codex_empty_thread_response_still_marks_partial_source() {
    let response =
        build_codex_daemon_empty_thread_response(CODEX_DAEMON_LOCAL_THREAD_LIST_PARTIAL_SOURCE);
    let result = response.get("result").and_then(Value::as_object).unwrap();

    assert_eq!(
        result.get("data").and_then(Value::as_array).unwrap().len(),
        0
    );
    assert!(result.get("nextCursor").unwrap().is_null());
    assert_eq!(
        result.get("partialSource").and_then(Value::as_str),
        Some(CODEX_DAEMON_LOCAL_THREAD_LIST_PARTIAL_SOURCE)
    );
}

#[test]
fn daemon_provider_profile_rejects_managed_ids() {
    assert_eq!(normalize_daemon_disk_provider_profile(None).unwrap(), None);
    assert_eq!(
        normalize_daemon_disk_provider_profile(Some("  ".to_string())).unwrap(),
        None
    );
    assert_eq!(
        normalize_daemon_disk_provider_profile(Some(
            codex::provider_profile::CODEX_DISK_PROVIDER_PROFILE_ID.to_string(),
        ))
        .unwrap(),
        Some(codex::provider_profile::CODEX_DISK_PROVIDER_PROFILE_ID.to_string())
    );
    let error =
        normalize_daemon_disk_provider_profile(Some("managed-provider".to_string())).unwrap_err();
    assert!(error.contains("provider-scoped runtime is unavailable in daemon mode"));
}

#[test]
fn daemon_provider_profile_stub_matches_shared_core_surface() {
    assert!(matches!(
        codex::provider_profile::resolve_codex_provider_profile(None).unwrap(),
        codex::provider_profile::CodexProviderProfile::Disk
    ));
    assert!(matches!(
        codex::provider_profile::resolve_codex_provider_profile(Some("  __disk__  ")).unwrap(),
        codex::provider_profile::CodexProviderProfile::Disk
    ));

    let error = codex::provider_profile::resolve_codex_provider_profile(Some("managed-provider"))
        .unwrap_err();
    assert!(error.contains("provider-scoped runtime is unavailable in daemon mode"));
}

#[tokio::test(flavor = "current_thread")]
async fn daemon_disk_start_confirms_ready_before_returning() {
    let events = Rc::new(RefCell::new(Vec::<String>::new()));
    let result = run_daemon_disk_start_thread_with_readiness(
        "ws-1",
        || {
            let events = Rc::clone(&events);
            async move {
                events.borrow_mut().push("ensure".to_string());
                Ok(())
            }
        },
        || {
            let events = Rc::clone(&events);
            async move {
                events.borrow_mut().push("start".to_string());
                Ok(json!({ "result": { "threadId": "thread-1" } }))
            }
        },
        |thread_id| {
            let events = Rc::clone(&events);
            async move {
                events.borrow_mut().push(format!("confirm:{thread_id}"));
                Ok(())
            }
        },
    )
    .await
    .unwrap();

    assert_eq!(
        codex_core::extract_thread_id_from_response(&result).as_deref(),
        Some("thread-1")
    );
    assert_eq!(
        events.borrow().as_slice(),
        ["ensure", "start", "confirm:thread-1"]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn daemon_disk_start_propagates_ready_confirmation_failure() {
    let events = Rc::new(RefCell::new(Vec::<String>::new()));
    let error = run_daemon_disk_start_thread_with_readiness(
        "ws-1",
        || {
            let events = Rc::clone(&events);
            async move {
                events.borrow_mut().push("ensure".to_string());
                Ok(())
            }
        },
        || {
            let events = Rc::clone(&events);
            async move {
                events.borrow_mut().push("start".to_string());
                Ok(json!({ "result": { "threadId": "thread-1" } }))
            }
        },
        |thread_id| {
            let events = Rc::clone(&events);
            async move {
                events.borrow_mut().push(format!("confirm:{thread_id}"));
                Err("thread/resume failed".to_string())
            }
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error, "thread/resume failed");
    assert_eq!(
        events.borrow().as_slice(),
        ["ensure", "start", "confirm:thread-1"]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn daemon_disk_start_retries_stopping_runtime_before_confirming() {
    let events = Rc::new(RefCell::new(Vec::<String>::new()));
    let start_count = Rc::new(RefCell::new(0_u8));
    let result = run_daemon_disk_start_thread_with_readiness(
        "ws-1",
        || {
            let events = Rc::clone(&events);
            async move {
                events.borrow_mut().push("ensure".to_string());
                Ok(())
            }
        },
        || {
            let events = Rc::clone(&events);
            let start_count = Rc::clone(&start_count);
            async move {
                let mut count = start_count.borrow_mut();
                *count += 1;
                events.borrow_mut().push(format!("start:{count}"));
                if *count == 1 {
                    Err("[RUNTIME_ENDED] stopped after manual_shutdown".to_string())
                } else {
                    Ok(json!({ "result": { "threadId": "thread-2" } }))
                }
            }
        },
        |thread_id| {
            let events = Rc::clone(&events);
            async move {
                events.borrow_mut().push(format!("confirm:{thread_id}"));
                Ok(())
            }
        },
    )
    .await
    .unwrap();

    assert_eq!(
        codex_core::extract_thread_id_from_response(&result).as_deref(),
        Some("thread-2")
    );
    assert_eq!(
        events.borrow().as_slice(),
        ["ensure", "start:1", "ensure", "start:2", "confirm:thread-2"]
    );
}
