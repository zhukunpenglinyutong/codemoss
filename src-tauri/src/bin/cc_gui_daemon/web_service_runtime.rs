use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Component, Path, PathBuf};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

const DEFAULT_WEB_PORT: u16 = 3080;
const STOP_TIMEOUT_SECS: u64 = 3;
const WEB_TOKEN_STORAGE_KEY: &str = "ccgui_web_token";
const WEB_ASSETS_ENV_KEY: &str = "MOSSX_WEB_ASSETS_DIR";
const ERROR_ALREADY_RUNNING: &str = "WEB_SERVICE_ALREADY_RUNNING";
const ERROR_INVALID_PORT: &str = "WEB_SERVICE_PORT_INVALID";
const ERROR_PORT_IN_USE: &str = "WEB_SERVICE_PORT_IN_USE";
const ERROR_BIND_FAILED: &str = "WEB_SERVICE_BIND_FAILED";
const ERROR_STOP_TIMEOUT: &str = "WEB_SERVICE_STOP_TIMEOUT";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebServerStatus {
    pub(crate) running: bool,
    pub(crate) rpc_endpoint: String,
    pub(crate) web_port: u16,
    pub(crate) addresses: Vec<String>,
    pub(crate) web_access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Clone)]
struct WebApiState {
    token: String,
    rpc_endpoint: String,
    rpc_token: Option<String>,
    assets_root: Option<PathBuf>,
}

struct RunningWebServer {
    port: u16,
    token: String,
    addresses: Vec<String>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

pub(crate) struct WebServiceRuntime {
    rpc_endpoint: String,
    rpc_auth_token: Option<String>,
    data_dir: PathBuf,
    default_port: u16,
    running: Option<RunningWebServer>,
    last_error: Option<String>,
}

impl WebServiceRuntime {
    pub(crate) fn new(
        rpc_endpoint: String,
        rpc_auth_token: Option<String>,
        default_port: u16,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            rpc_endpoint,
            rpc_auth_token,
            data_dir,
            default_port: sanitize_port(default_port),
            running: None,
            last_error: None,
        }
    }

    pub(crate) fn set_default_port(&mut self, port: u16) {
        self.default_port = sanitize_port(port);
    }

    pub(crate) async fn start(
        &mut self,
        requested_port: Option<u16>,
        requested_token: Option<String>,
    ) -> Result<WebServerStatus, String> {
        self.cleanup_finished_server();
        if self.running.is_some() {
            return Err(ERROR_ALREADY_RUNNING.to_string());
        }

        let target_port = sanitize_port(requested_port.unwrap_or(self.default_port));
        validate_port(target_port)?;

        let token = normalize_token(requested_token).unwrap_or_else(generate_access_token);
        let listener = TcpListener::bind(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            target_port,
        ))
        .await
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::AddrInUse {
                format!("{ERROR_PORT_IN_USE}:{target_port}")
            } else {
                format!("{ERROR_BIND_FAILED}:{err}")
            }
        })?;
        let bound_port = listener
            .local_addr()
            .map_err(|err| format!("failed to read bound address: {err}"))?
            .port();
        let addresses = build_access_addresses(bound_port);
        let assets_root = resolve_web_assets_root(Some(&self.data_dir));
        if assets_root.is_none() {
            eprintln!(
                "[web-service] frontend assets not found, fallback pages only (set {WEB_ASSETS_ENV_KEY})"
            );
        }
        let app_state = WebApiState {
            token: token.clone(),
            rpc_endpoint: self.rpc_endpoint.clone(),
            rpc_token: self.rpc_auth_token.clone(),
            assets_root,
        };

        let router = Router::new()
            .route("/", get(web_root))
            .route("/login", get(web_login))
            .route("/welcome", get(web_welcome))
            .route("/app", get(web_app_entry))
            .route("/app/*path", get(web_app_entry))
            .route("/api/health", post(api_health))
            .route("/api/ping", get(api_ping))
            .route("/api/rpc", post(api_rpc))
            .route("/ws", get(ws_endpoint))
            .fallback(get(web_static_entry))
            .with_state(app_state);

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let server = axum::serve(listener, router).with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            });
            if let Err(err) = server.await {
                eprintln!("[web-service] server exited with error: {err}");
            }
        });

        self.default_port = bound_port;
        self.last_error = None;
        self.running = Some(RunningWebServer {
            port: bound_port,
            token,
            addresses,
            shutdown_tx: Some(shutdown_tx),
            task,
        });
        Ok(self.status())
    }

    pub(crate) async fn stop(&mut self) -> WebServerStatus {
        self.cleanup_finished_server();
        let Some(mut running) = self.running.take() else {
            return self.status();
        };

        self.default_port = running.port;
        if let Some(shutdown_tx) = running.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        let wait_result = timeout(Duration::from_secs(STOP_TIMEOUT_SECS), &mut running.task).await;
        if wait_result.is_err() {
            running.task.abort();
            self.last_error = Some(ERROR_STOP_TIMEOUT.to_string());
        } else if let Ok(join_result) = wait_result {
            if let Err(err) = join_result {
                self.last_error = Some(format!("web service task join error: {err}"));
            } else {
                self.last_error = None;
            }
        }
        self.status()
    }

    pub(crate) fn status(&mut self) -> WebServerStatus {
        self.cleanup_finished_server();
        if let Some(running) = self.running.as_ref() {
            return WebServerStatus {
                running: true,
                rpc_endpoint: self.rpc_endpoint.clone(),
                web_port: running.port,
                addresses: running.addresses.clone(),
                web_access_token: Some(running.token.clone()),
                last_error: self.last_error.clone(),
            };
        }

        WebServerStatus {
            running: false,
            rpc_endpoint: self.rpc_endpoint.clone(),
            web_port: self.default_port,
            addresses: Vec::new(),
            web_access_token: None,
            last_error: self.last_error.clone(),
        }
    }

    fn cleanup_finished_server(&mut self) {
        let Some(running) = self.running.as_ref() else {
            return;
        };
        if !running.task.is_finished() {
            return;
        }
        self.default_port = running.port;
        self.last_error = Some("web service exited unexpectedly".to_string());
        self.running = None;
    }
}

async fn api_ping(
    State(state): State<WebApiState>,
    headers: HeaderMap,
    query: Query<TokenQuery>,
) -> Response {
    if !is_authorized(&state.token, &headers, &query) {
        return unauthorized_response();
    }
    Json(json!({ "ok": true })).into_response()
}

async fn api_health(
    State(state): State<WebApiState>,
    headers: HeaderMap,
    query: Query<TokenQuery>,
) -> Response {
    if !is_authorized(&state.token, &headers, &query) {
        return unauthorized_response();
    }
    Json(json!({ "ok": true, "service": "ccgui-web" })).into_response()
}

async fn web_root() -> Html<String> {
    Html(
        r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>CodePort Web Service</title>
  </head>
  <body>
    <div style="padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Helvetica Neue',Arial,sans-serif;">
      Redirecting...
    </div>
    <script>
      (function () {
        const tokenFromQuery = new URLSearchParams(location.search).get("token");
        if (tokenFromQuery) {
          localStorage.setItem("mossx_web_token", tokenFromQuery);
          location.replace("/app");
          return;
        }
        const token = localStorage.getItem("mossx_web_token");
        if (token) {
          location.replace("/app");
        } else {
          location.replace("/login");
        }
      })();
    </script>
  </body>
</html>
"#
        .to_string(),
    )
}

async fn web_login() -> Html<String> {
    Html(format!(
        r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>CodePort Web Service Login</title>
    <style>
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
        background: #f7f8fb;
        color: #101827;
      }}
      .card {{
        width: min(560px, 92vw);
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        padding: 22px;
        box-shadow: 0 8px 24px rgba(16,24,40,0.06);
      }}
      h1 {{ margin: 0 0 8px; font-size: 28px; line-height: 1.2; }}
      p {{ margin: 0; color: #667085; }}
      .row {{ margin-top: 18px; display: flex; gap: 10px; }}
      input {{
        flex: 1;
        min-width: 200px;
        border: 1px solid #d0d5dd;
        border-radius: 10px;
        padding: 11px 12px;
        font-size: 15px;
      }}
      button {{
        border: 1px solid #2563eb;
        background: #2563eb;
        color: #fff;
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 14px;
        cursor: pointer;
      }}
      button:disabled {{ opacity: 0.6; cursor: not-allowed; }}
      .hint {{ margin-top: 12px; font-size: 13px; color: #667085; }}
      .error {{ margin-top: 12px; font-size: 13px; color: #b42318; }}
    </style>
  </head>
  <body>
    <main class="card">
      <h1>CodePort</h1>
      <p>输入访问 Token 以连接桌面端 / Enter access token to connect.</p>
      <div class="row">
        <input id="tokenInput" type="password" placeholder="Access Token" autocomplete="off" />
        <button id="connectBtn" type="button">连接 / Connect</button>
      </div>
      <div id="error" class="error"></div>
      <div class="hint">Token 可在桌面端 设置 → Web 服务 中获取。</div>
    </main>
    <script>
      (function () {{
        const storageKey = {storage_key};
        const input = document.getElementById("tokenInput");
        const button = document.getElementById("connectBtn");
        const error = document.getElementById("error");
        const tokenFromQuery = new URLSearchParams(location.search).get("token");
        const tokenFromStorage = localStorage.getItem(storageKey);
        const initialToken = tokenFromQuery || tokenFromStorage || "";
        if (initialToken) {{
          input.value = initialToken;
        }}

        function setError(text) {{
          error.textContent = text || "";
        }}

        async function connect() {{
          const token = (input.value || "").trim();
          if (!token) {{
            setError("请输入 Token");
            return;
          }}
          button.disabled = true;
          setError("");
          try {{
            const response = await fetch("/api/health", {{
              method: "POST",
              headers: {{
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token
              }},
              body: "{{}}",
              cache: "no-store",
            }});
            if (!response.ok) {{
              setError(response.status === 401 ? "Token 无效，请检查后重试。" : ("连接失败 (HTTP " + response.status + ")"));
              return;
            }}
            localStorage.setItem(storageKey, token);
            location.replace("/app");
          }} catch (_) {{
            setError("无法连接到服务。");
          }} finally {{
            button.disabled = false;
          }}
        }}

        button.addEventListener("click", connect);
        input.addEventListener("keydown", function (event) {{
          if (event.key === "Enter") {{
            event.preventDefault();
            connect();
          }}
        }});
      }})();
    </script>
  </body>
</html>
"#,
        storage_key = serde_json::to_string(WEB_TOKEN_STORAGE_KEY)
            .unwrap_or_else(|_| "\"mossx_web_token\"".to_string()),
    ))
}

async fn web_welcome() -> Html<String> {
    Html(format!(
        r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>CodePort Web Service</title>
  </head>
  <body>
    <div style="padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Helvetica Neue',Arial,sans-serif;">
      Redirecting...
    </div>
    <script>
      (function () {{
        const storageKey = {storage_key};
        const tokenFromQuery = new URLSearchParams(location.search).get("token");
        if (tokenFromQuery) {{
          localStorage.setItem(storageKey, tokenFromQuery);
        }}
        if (!localStorage.getItem(storageKey)) {{
          location.replace("/login");
          return;
        }}
        location.replace("/app");
      }})();
    </script>
  </body>
</html>
"#,
        storage_key = serde_json::to_string(WEB_TOKEN_STORAGE_KEY)
            .unwrap_or_else(|_| "\"mossx_web_token\"".to_string()),
    ))
}

async fn web_app_entry(State(state): State<WebApiState>) -> Response {
    serve_web_app_index(&state).await
}

async fn web_static_entry(State(state): State<WebApiState>, uri: Uri) -> Response {
    let raw_path = uri.path().trim_start_matches('/');
    if raw_path.is_empty() {
        return web_root().await.into_response();
    }
    if raw_path == "login" {
        return web_login().await.into_response();
    }
    if raw_path == "welcome" {
        return web_welcome().await.into_response();
    }
    if raw_path == "app" || raw_path.starts_with("app/") {
        return serve_web_app_index(&state).await;
    }

    let Some(relative) = sanitize_relative_path(raw_path) else {
        return (StatusCode::BAD_REQUEST, "invalid path").into_response();
    };
    if let Some(response) = try_serve_asset_file(&state, &relative).await {
        return response;
    }

    if Path::new(raw_path).extension().is_none() {
        return serve_web_app_index(&state).await;
    }
    (StatusCode::NOT_FOUND, "not found").into_response()
}

async fn serve_web_app_index(state: &WebApiState) -> Response {
    let Some(root) = state.assets_root.as_ref() else {
        return Html(
            r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>CodePort Web Service</title>
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Helvetica Neue',Arial,sans-serif;padding:24px;">
    <h2 style="margin:0 0 8px;">CodePort Web Service</h2>
    <p style="margin:0;color:#6b7280;">Web 前端资源不存在，请先构建前端或设置 MOSSX_WEB_ASSETS_DIR 指向 dist 目录。</p>
  </body>
</html>"#
                .to_string(),
        )
        .into_response();
    };

    let index_path = root.join("index.html");
    let source = match fs::read_to_string(&index_path).await {
        Ok(content) => content,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "failed to read web index at {}: {error}",
                    index_path.display()
                ),
            )
                .into_response();
        }
    };
    let injected = inject_web_tauri_shim(&source);
    response_with_bytes("text/html; charset=utf-8", injected.into_bytes())
}

async fn try_serve_asset_file(state: &WebApiState, relative: &Path) -> Option<Response> {
    let root = state.assets_root.as_ref()?;
    let mut candidates = vec![root.join(relative)];

    // Compatibility fallback: some bundle pipelines may flatten dist/assets/* into dist/*
    // while index.html still references /assets/*. Try filename at dist root as a backup.
    if is_assets_relative(relative) {
        if let Some(file_name) = relative.file_name() {
            candidates.push(root.join(file_name));
        }
    }

    for absolute in candidates {
        let metadata = match fs::metadata(&absolute).await {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }
        let bytes = fs::read(&absolute).await.ok()?;
        let content_type = content_type_for_path(relative);
        return Some(response_with_bytes(content_type, bytes));
    }

    None
}

fn is_assets_relative(path: &Path) -> bool {
    match path.components().next() {
        Some(Component::Normal(value)) => value
            .to_str()
            .map(|segment| segment.eq_ignore_ascii_case("assets"))
            .unwrap_or(false),
        _ => false,
    }
}

fn response_with_bytes(content_type: &str, bytes: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(bytes));
    if let Ok(value) = HeaderValue::from_str(content_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response
}

fn sanitize_relative_path(raw: &str) -> Option<PathBuf> {
    let mut relative = PathBuf::new();
    for component in Path::new(raw).components() {
        match component {
            Component::Normal(value) => relative.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(relative)
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("webm") => "video/webm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn api_rpc(
    State(state): State<WebApiState>,
    headers: HeaderMap,
    query: Query<TokenQuery>,
    Json(payload): Json<Value>,
) -> Response {
    if !is_authorized(&state.token, &headers, &query) {
        return unauthorized_response();
    }

    let response = match serde_json::from_value::<RpcRequest>(payload) {
        Ok(request) => {
            if request.method == "ping" {
                json!({
                    "id": request.id,
                    "result": json!({ "ok": true }),
                })
            } else {
                match call_daemon_rpc(
                    &state.rpc_endpoint,
                    state.rpc_token.as_deref(),
                    &request.method,
                    request.params,
                )
                .await
                {
                    Ok(result) => json!({
                        "id": request.id,
                        "result": result,
                    }),
                    Err(message) => json!({
                        "id": request.id,
                        "error": { "message": message },
                    }),
                }
            }
        }
        Err(err) => json!({
            "error": format!("invalid rpc payload: {err}"),
        }),
    };
    Json(response).into_response()
}

async fn ws_endpoint(
    ws: WebSocketUpgrade,
    State(state): State<WebApiState>,
    headers: HeaderMap,
    query: Query<TokenQuery>,
) -> Response {
    if !is_authorized(&state.token, &headers, &query) {
        return unauthorized_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

async fn handle_socket(mut socket: WebSocket, state: WebApiState) {
    let stream = match TcpStream::connect(&state.rpc_endpoint).await {
        Ok(stream) => stream,
        Err(err) => {
            let _ = socket
                .send(Message::Text(
                    json!({
                        "error": {
                            "message": format!(
                                "failed to connect daemon rpc endpoint {}: {}",
                                state.rpc_endpoint, err
                            )
                        }
                    })
                    .to_string(),
                ))
                .await;
            return;
        }
    };

    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    if let Err(error) =
        authenticate_daemon_connection(&mut lines, &mut writer, state.rpc_token.as_deref()).await
    {
        let _ = socket
            .send(Message::Text(
                json!({ "error": { "message": error } }).to_string(),
            ))
            .await;
        return;
    }

    let _ = socket
        .send(Message::Text(
            json!({ "method": "web-service-ready", "params": { "ok": true } }).to_string(),
        ))
        .await;

    loop {
        tokio::select! {
            socket_message = socket.recv() => {
                let Some(Ok(message)) = socket_message else {
                    break;
                };
                match message {
                    Message::Text(text) => {
                        if writer.write_all(text.as_bytes()).await.is_err() || writer.write_all(b"\n").await.is_err() {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    _ => {}
                }
            }
            daemon_line = lines.next_line() => {
                match daemon_line {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        if socket.send(Message::Text(line)).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        }
    }
}

fn is_authorized(expected_token: &str, headers: &HeaderMap, query: &Query<TokenQuery>) -> bool {
    if let Some(token) = query.token.as_ref() {
        if token == expected_token {
            return true;
        }
    }
    parse_bearer_token(headers)
        .map(|token| token == expected_token)
        .unwrap_or(false)
}

fn parse_bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("authorization")?.to_str().ok()?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut parts = raw.splitn(2, ' ');
    let scheme = parts.next().unwrap_or_default();
    let value = parts.next().unwrap_or_default().trim();
    if scheme.eq_ignore_ascii_case("bearer") && !value.is_empty() {
        Some(value.to_string())
    } else {
        None
    }
}

async fn authenticate_daemon_connection(
    lines: &mut tokio::io::Lines<BufReader<OwnedReadHalf>>,
    writer: &mut OwnedWriteHalf,
    token: Option<&str>,
) -> Result<(), String> {
    let Some(token) = token.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }) else {
        return Ok(());
    };

    let auth_request = json!({
        "id": 0,
        "method": "auth",
        "params": { "token": token },
    });
    let payload = serde_json::to_string(&auth_request).map_err(|err| err.to_string())?;
    writer
        .write_all(payload.as_bytes())
        .await
        .map_err(|err| format!("failed to send daemon auth request: {err}"))?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|err| format!("failed to send daemon auth request: {err}"))?;

    let auth_line = lines
        .next_line()
        .await
        .map_err(|err| format!("failed to read daemon auth response: {err}"))?
        .ok_or_else(|| "daemon auth response missing".to_string())?;
    let auth_response: Value =
        serde_json::from_str(&auth_line).map_err(|err| format!("invalid auth response: {err}"))?;
    if let Some(error_message) = auth_response
        .get("error")
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
    {
        return Err(error_message.to_string());
    }
    Ok(())
}

async fn call_daemon_rpc(
    endpoint: &str,
    token: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let stream = TcpStream::connect(endpoint)
        .await
        .map_err(|err| format!("failed to connect daemon rpc endpoint {endpoint}: {err}"))?;
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    authenticate_daemon_connection(&mut lines, &mut writer, token).await?;

    let request_id = 1u64;
    let request = json!({
        "id": request_id,
        "method": method,
        "params": params,
    });
    let payload = serde_json::to_string(&request).map_err(|err| err.to_string())?;
    writer
        .write_all(payload.as_bytes())
        .await
        .map_err(|err| format!("failed to send daemon rpc request: {err}"))?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|err| format!("failed to send daemon rpc request: {err}"))?;

    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|err| format!("failed to read daemon rpc response: {err}"))?
    {
        if line.trim().is_empty() {
            continue;
        }
        let response: Value =
            serde_json::from_str(&line).map_err(|err| format!("invalid daemon response: {err}"))?;
        if response
            .get("id")
            .and_then(Value::as_u64)
            .filter(|id| *id == request_id)
            .is_none()
        {
            continue;
        }
        if let Some(error_message) = response
            .get("error")
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
        {
            return Err(error_message.to_string());
        }
        return Ok(response.get("result").cloned().unwrap_or(Value::Null));
    }

    Err("daemon rpc response missing".to_string())
}

fn inject_web_tauri_shim(index_html: &str) -> String {
    let script = build_web_tauri_shim_script();
    let injected = format!("<script>{script}</script>");
    if let Some(head_close) = index_html.find("</head>") {
        let mut output = String::with_capacity(index_html.len() + injected.len() + 8);
        output.push_str(&index_html[..head_close]);
        output.push_str(&injected);
        output.push_str(&index_html[head_close..]);
        return output;
    }

    let mut output = String::with_capacity(index_html.len() + injected.len());
    output.push_str(index_html);
    output.push_str(&injected);
    output
}

fn build_web_tauri_shim_script() -> String {
    format!(
        r#"(function () {{
  if (typeof window === "undefined") {{
    return;
  }}
  if (window.__MOSSX_WEB_TAURI_SHIM__) {{
    return;
  }}
  window.__MOSSX_WEB_TAURI_SHIM__ = true;

  const storageKey = {storage_key};
  const queryToken = new URLSearchParams(location.search).get("token");
  if (queryToken) {{
    localStorage.setItem(storageKey, queryToken);
  }}
  if (!(localStorage.getItem(storageKey) || "").trim() && location.pathname.startsWith("/app")) {{
    location.replace("/login");
    return;
  }}

  const callbackStore = new Map();
  const listenerStore = new Map();
  let callbackSeq = 1;
  let listenerSeq = 1;
  let requestSeq = 1;
  let ws = null;
  let reconnectTimer = null;
  let socketOpenedBefore = false;

  function readToken() {{
    return (localStorage.getItem(storageKey) || "").trim();
  }}

  function goLogin() {{
    if (location.pathname !== "/login") {{
      location.replace("/login");
    }}
  }}

  function normalizeErrorMessage(error, fallback) {{
    if (error instanceof Error && error.message) {{
      return error.message;
    }}
    if (typeof error === "string" && error) {{
      return error;
    }}
    return fallback;
  }}

  function transformCallback(callback, once) {{
    const id = callbackSeq++;
    callbackStore.set(id, {{ callback: callback, once: Boolean(once) }});
    return id;
  }}

  function unregisterCallback(id) {{
    callbackStore.delete(Number(id));
  }}

  function emitCallback(callbackId, payload) {{
    const entry = callbackStore.get(Number(callbackId));
    if (!entry) {{
      return;
    }}
    try {{
      entry.callback(payload);
    }} catch (error) {{
      console.error("[ccgui-web] callback failed", error);
    }} finally {{
      if (entry.once) {{
        callbackStore.delete(Number(callbackId));
      }}
    }}
  }}

  function dispatchEvent(eventName, payload) {{
    for (const [listenerId, subscription] of listenerStore.entries()) {{
      if (subscription.event !== eventName) {{
        continue;
      }}
      emitCallback(subscription.callbackId, {{
        event: eventName,
        id: listenerId,
        payload: payload
      }});
    }}
  }}

  function scheduleReconnect() {{
    if (reconnectTimer != null) {{
      return;
    }}
    reconnectTimer = window.setTimeout(function () {{
      reconnectTimer = null;
      ensureSocket();
    }}, 1200);
  }}

  function ensureSocket() {{
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {{
      return;
    }}
    const token = readToken();
    if (!token) {{
      return;
    }}
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(protocol + "://" + location.host + "/ws?token=" + encodeURIComponent(token));
    ws.onopen = function () {{
      if (socketOpenedBefore) {{
        window.dispatchEvent(new CustomEvent("ccgui:web-service-reconnected"));
        return;
      }}
      socketOpenedBefore = true;
    }};
    ws.onmessage = function (event) {{
      if (!event || typeof event.data !== "string") {{
        return;
      }}
      let payload;
      try {{
        payload = JSON.parse(event.data);
      }} catch (_) {{
        return;
      }}
      if (payload && typeof payload.method === "string") {{
        dispatchEvent(payload.method, payload.params ?? null);
      }}
    }};
    ws.onclose = function () {{
      ws = null;
      if (listenerStore.size > 0) {{
        scheduleReconnect();
      }}
    }};
    ws.onerror = function () {{
      if (ws && ws.readyState !== WebSocket.OPEN) {{
        scheduleReconnect();
      }}
    }};
  }}

  async function invokeRpc(method, params) {{
    const token = readToken();
    if (!token) {{
      goLogin();
      throw new Error("missing web access token");
    }}
    const response = await fetch("/api/rpc", {{
      method: "POST",
      headers: {{
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      }},
      body: JSON.stringify({{
        id: requestSeq++,
        method: method,
        params: params ?? {{}}
      }}),
      cache: "no-store"
    }});
    if (response.status === 401) {{
      localStorage.removeItem(storageKey);
      goLogin();
      throw new Error("unauthorized");
    }}
    if (!response.ok) {{
      throw new Error("HTTP " + response.status);
    }}
    const payload = await response.json();
    if (payload && payload.error) {{
      throw new Error(String(payload.error.message || payload.error || "rpc error"));
    }}
    return payload ? payload.result : null;
  }}

  function registerEventListener(eventName, callbackId) {{
    const listenerId = listenerSeq++;
    listenerStore.set(listenerId, {{ event: eventName, callbackId: Number(callbackId) }});
    ensureSocket();
    return listenerId;
  }}

  function unregisterEventListener(listenerId) {{
    listenerStore.delete(Number(listenerId));
  }}

  async function invoke(command, args) {{
    const cmd = String(command || "");
    const payload = args || {{}};

    if (cmd === "plugin:event|listen") {{
      return registerEventListener(String(payload.event || ""), Number(payload.handler || 0));
    }}
    if (cmd === "plugin:event|unlisten") {{
      unregisterEventListener(payload.eventId);
      return null;
    }}
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {{
      return null;
    }}
    if (cmd === "plugin:app|version") {{
      return "web-service";
    }}
    if (cmd === "plugin:app|name") {{
      return "CodePort Web";
    }}
    if (cmd.startsWith("plugin:path|")) {{
      return "";
    }}
    if (cmd === "plugin:window|get_all_windows") {{
      return [{{ label: "main" }}];
    }}
    if (cmd.startsWith("plugin:window|")) {{
      return null;
    }}
    if (cmd === "plugin:webview|get_all_webviews") {{
      return [{{ label: "main", windowLabel: "main" }}];
    }}
    if (cmd.startsWith("plugin:webview|")) {{
      return null;
    }}
    if (cmd.startsWith("plugin:dialog|")) {{
      return null;
    }}
    if (cmd.startsWith("plugin:notification|")) {{
      return false;
    }}
    if (cmd.startsWith("plugin:process|") || cmd.startsWith("plugin:updater|")) {{
      return null;
    }}
    if (cmd === "plugin:opener|open_url") {{
      const url = typeof payload.url === "string" ? payload.url : "";
      if (url) {{
        window.open(url, "_blank", "noopener");
      }}
      return null;
    }}
    if (cmd.startsWith("plugin:opener|")) {{
      return null;
    }}

    try {{
      return await invokeRpc(cmd, payload);
    }} catch (error) {{
      throw new Error(normalizeErrorMessage(error, "rpc invoke failed"));
    }}
  }}

  window.__MOSSX_WEB_SERVICE__ = true;

  window.__TAURI_INTERNALS__ = Object.assign({{}}, window.__TAURI_INTERNALS__, {{
    metadata: {{
      currentWindow: {{ label: "main" }},
      currentWebview: {{ label: "main" }}
    }},
    invoke: invoke,
    transformCallback: transformCallback,
    unregisterCallback: unregisterCallback,
    convertFileSrc: function (filePath) {{
      return String(filePath || "");
    }}
  }});

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = Object.assign(
    {{}},
    window.__TAURI_EVENT_PLUGIN_INTERNALS__,
    {{
      unregisterListener: function (_eventName, eventId) {{
        unregisterEventListener(eventId);
      }}
    }}
  );

  ensureSocket();
}})();"#,
        storage_key = serde_json::to_string(WEB_TOKEN_STORAGE_KEY)
            .unwrap_or_else(|_| "\"mossx_web_token\"".to_string()),
    )
}

fn resolve_web_assets_root(data_dir: Option<&Path>) -> Option<PathBuf> {
    let env_assets_root = env::var_os(WEB_ASSETS_ENV_KEY).map(PathBuf::from);
    let cwd = env::current_dir().ok();
    let current_exe = env::current_exe().ok();
    let appdir = env::var_os("APPDIR").map(PathBuf::from);
    let candidates = collect_web_asset_candidates_for_platform(
        env_assets_root.as_deref(),
        data_dir,
        cwd.as_deref(),
        current_exe.as_deref(),
        appdir.as_deref(),
        cfg!(target_os = "linux"),
    );

    resolve_web_assets_root_from_candidates(candidates)
}

fn resolve_web_assets_root_from_candidates(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|candidate| is_valid_web_assets_root(candidate))
}

fn is_valid_web_assets_root(candidate: &Path) -> bool {
    if !candidate.is_dir() {
        return false;
    }

    let index_path = candidate.join("index.html");
    let Ok(index_html) = std::fs::read_to_string(index_path) else {
        return false;
    };

    let has_react_root = index_html.contains("id=\"root\"") || index_html.contains("id='root'");
    let has_entry_asset = index_html.contains("/assets/")
        || index_html.contains("type=\"module\"")
        || index_html.contains("type='module'");
    has_react_root && has_entry_asset
}

fn collect_web_asset_candidates_for_platform(
    env_assets_root: Option<&Path>,
    data_dir: Option<&Path>,
    cwd: Option<&Path>,
    current_exe: Option<&Path>,
    appdir: Option<&Path>,
    linux_bundle_enabled: bool,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env_assets_root {
        candidates.push(path.to_path_buf());
        candidates.push(path.join("dist"));
    }
    if let Some(data_dir) = data_dir {
        candidates.push(data_dir.join("web-assets/current"));
    }
    if let Some(cwd) = cwd {
        append_asset_candidates(cwd, &mut candidates);
    }
    if let Some(appdir) = appdir {
        append_linux_bundle_asset_candidates(appdir, linux_bundle_enabled, &mut candidates);
    }
    if let Some(current_exe) = current_exe {
        if let Some(parent) = current_exe.parent() {
            append_asset_candidates(parent, &mut candidates);
            if let Some(grand_parent) = parent.parent() {
                append_asset_candidates(grand_parent, &mut candidates);
                append_linux_bundle_asset_candidates_from_exe(
                    current_exe,
                    grand_parent,
                    linux_bundle_enabled,
                    &mut candidates,
                );
            }
        }
    }

    candidates
}

fn append_asset_candidates(base: &Path, output: &mut Vec<PathBuf>) {
    output.push(base.join("dist"));
    output.push(base.join("../dist"));
    output.push(base.join("resources"));
    output.push(base.join("resources/dist"));
    output.push(base.join("Resources"));
    output.push(base.join("Resources/dist"));
}

fn append_linux_bundle_asset_candidates(
    base: &Path,
    linux_bundle_enabled: bool,
    output: &mut Vec<PathBuf>,
) {
    if !linux_bundle_enabled {
        return;
    }
    output.push(base.join("usr/lib/ccgui/dist"));
    output.push(base.join("lib/ccgui/dist"));
}

fn append_linux_bundle_asset_candidates_from_exe(
    current_exe: &Path,
    base: &Path,
    linux_bundle_enabled: bool,
    output: &mut Vec<PathBuf>,
) {
    if !linux_bundle_enabled || !is_linux_bundle_daemon_exe(current_exe) {
        return;
    }
    append_linux_bundle_asset_candidates(base, linux_bundle_enabled, output);
}

fn is_linux_bundle_daemon_exe(current_exe: &Path) -> bool {
    let Some(file_name) = current_exe.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if file_name != "cc_gui_daemon" && file_name != "moss_x_daemon" && file_name != "moss-x-daemon"
    {
        return false;
    }
    current_exe
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|value| value.to_str())
        .is_some_and(|directory| directory == "bin")
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "error": "unauthorized",
            "message": "missing or invalid web access token",
        })),
    )
        .into_response()
}

fn sanitize_port(value: u16) -> u16 {
    if value == 0 {
        DEFAULT_WEB_PORT
    } else {
        value
    }
}

fn validate_port(port: u16) -> Result<(), String> {
    if (1024..=65535).contains(&port) {
        return Ok(());
    }
    Err(format!("{ERROR_INVALID_PORT}:{port}"))
}

fn normalize_token(value: Option<String>) -> Option<String> {
    value
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

fn generate_access_token() -> String {
    Uuid::new_v4().as_simple().to_string()
}

fn build_access_addresses(port: u16) -> Vec<String> {
    let mut addresses = BTreeSet::new();
    addresses.insert(format!("http://127.0.0.1:{port}"));
    addresses.insert(format!("http://localhost:{port}"));
    if let Some(ip) = resolve_lan_ip() {
        addresses.insert(format!("http://{ip}:{port}"));
    }
    addresses.into_iter().collect()
}

fn resolve_lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_unspecified() || ip.is_loopback() {
        return None;
    }
    Some(ip)
}

#[cfg(test)]
mod tests {
    use super::{
        collect_web_asset_candidates_for_platform, is_valid_web_assets_root, parse_bearer_token,
        resolve_web_assets_root_from_candidates, validate_port,
    };
    use axum::http::{HeaderMap, HeaderValue};
    use std::path::Path;

    #[test]
    fn validate_port_rejects_reserved_range() {
        assert!(validate_port(80).is_err());
        assert!(validate_port(3080).is_ok());
    }

    #[test]
    fn parse_bearer_token_reads_authorization_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer token-123"),
        );
        assert_eq!(parse_bearer_token(&headers).as_deref(), Some("token-123"));
    }

    #[test]
    fn web_asset_candidates_include_linux_appimage_appdir_layout() {
        let candidates = collect_web_asset_candidates_for_platform(
            None,
            None,
            None,
            Some(Path::new("/tmp/.mount_ccgui_abc/usr/bin/cc_gui_daemon")),
            Some(Path::new("/tmp/.mount_ccgui_abc")),
            true,
        );

        assert!(candidates
            .contains(&Path::new("/tmp/.mount_ccgui_abc/usr/lib/ccgui/dist").to_path_buf()));
    }

    #[test]
    fn web_asset_candidates_include_linux_bundle_layout_from_exe_ancestor() {
        let candidates = collect_web_asset_candidates_for_platform(
            None,
            None,
            None,
            Some(Path::new("/tmp/.mount_ccgui_abc/usr/bin/cc_gui_daemon")),
            None,
            true,
        );

        assert!(candidates
            .contains(&Path::new("/tmp/.mount_ccgui_abc/usr/lib/ccgui/dist").to_path_buf()));
    }

    #[test]
    fn web_asset_candidates_do_not_add_linux_bundle_layout_for_non_daemon_exe() {
        let candidates = collect_web_asset_candidates_for_platform(
            None,
            None,
            None,
            Some(Path::new("/opt/other-app/current/bin/helper")),
            None,
            true,
        );

        assert!(
            !candidates.contains(&Path::new("/opt/other-app/current/lib/ccgui/dist").to_path_buf())
        );
    }

    #[test]
    fn web_asset_candidates_do_not_add_linux_bundle_layout_when_platform_disabled() {
        let candidates = collect_web_asset_candidates_for_platform(
            None,
            None,
            None,
            Some(Path::new("/tmp/.mount_ccgui_abc/usr/bin/cc_gui_daemon")),
            Some(Path::new("/tmp/.mount_ccgui_abc")),
            false,
        );

        assert!(!candidates
            .contains(&Path::new("/tmp/.mount_ccgui_abc/usr/lib/ccgui/dist").to_path_buf()));
    }

    #[test]
    fn web_asset_candidates_include_managed_data_directory() {
        let candidates = collect_web_asset_candidates_for_platform(
            None,
            Some(Path::new("/tmp/ccgui-data")),
            None,
            None,
            None,
            false,
        );

        assert_eq!(
            candidates.first().map(|path| path.as_path()),
            Some(Path::new("/tmp/ccgui-data/web-assets/current"))
        );
    }

    #[test]
    fn explicit_web_assets_override_precedes_managed_data_directory() {
        let candidates = collect_web_asset_candidates_for_platform(
            Some(Path::new("/tmp/explicit-assets")),
            Some(Path::new("/tmp/ccgui-data")),
            None,
            None,
            None,
            false,
        );

        assert_eq!(
            candidates
                .iter()
                .take(3)
                .map(|path| path.as_path())
                .collect::<Vec<_>>(),
            vec![
                Path::new("/tmp/explicit-assets"),
                Path::new("/tmp/explicit-assets/dist"),
                Path::new("/tmp/ccgui-data/web-assets/current"),
            ]
        );
    }

    #[test]
    fn web_assets_root_rejects_empty_shell_index() {
        let root = unique_test_dir("empty-shell-web-assets");
        let dist = root.join("dist");
        std::fs::create_dir_all(&dist).expect("create test dist");
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><html><body></body></html>",
        )
        .expect("write empty index");

        assert!(!is_valid_web_assets_root(&dist));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn web_assets_root_skips_empty_shell_and_uses_valid_dist() {
        let root = unique_test_dir("web-assets-candidates");
        let empty_dist = root.join("src-tauri/dist");
        let valid_dist = root.join("dist");
        std::fs::create_dir_all(&empty_dist).expect("create empty dist");
        std::fs::create_dir_all(&valid_dist).expect("create valid dist");
        std::fs::write(
            empty_dist.join("index.html"),
            "<!doctype html><html><body></body></html>",
        )
        .expect("write empty index");
        std::fs::write(
            valid_dist.join("index.html"),
            r#"<!doctype html><html><head><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>"#,
        )
        .expect("write valid index");

        let selected =
            resolve_web_assets_root_from_candidates(vec![empty_dist, valid_dist.clone()]);

        assert_eq!(selected.as_deref(), Some(valid_dist.as_path()));

        let _ = std::fs::remove_dir_all(root);
    }

    fn unique_test_dir(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4().as_simple()))
    }
}
