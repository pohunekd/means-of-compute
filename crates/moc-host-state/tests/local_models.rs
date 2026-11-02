use moc_host_state::local_models::query_local_models;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

#[test]
fn local_models_query() {
    // Start a TcpListener on 127.0.0.1:0 that answers 200 then 404.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind should succeed");
    let addr = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        // First request: 200 with payload containing duplicates and invalid entries.
        for i in 0..2 {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                if i == 0 {
                    let body =
                        r#"{"data":[{"id":"m1"},{"id":"m1"},{"id":""},{"id":2},"x",{"id":"m2"}]}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.flush();
                } else {
                    let resp =
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.flush();
                }
            }
        }
    });

    // Allow server thread to start
    std::thread::sleep(std::time::Duration::from_millis(50));

    let base_with_slash = format!("http://{addr}/");
    let (ok, models) = query_local_models(&base_with_slash, 2000.0);
    assert!(ok, "expected reachable true for 200");
    assert_eq!(models, vec!["m1".to_string(), "m2".to_string()]);

    // Second request should get 404 -> (false, [])
    let base_no_slash = format!("http://{addr}");
    let (ok2, models2) = query_local_models(&base_no_slash, 2000.0);
    assert!(!ok2, "expected reachable false for 404");
    assert!(models2.is_empty());

    // Empty base returns (false, []) without socket
    let (ok3, models3) = query_local_models("", 2000.0);
    assert!(!ok3);
    assert!(models3.is_empty());

    let _ = handle.join();
}
