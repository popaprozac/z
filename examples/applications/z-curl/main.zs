import curl from "curl/curl.h";
import console from "std/console";

struct CurlRuntime {
    deinit {
        curl.curl_global_cleanup();
    }
}

function initializeCurl(): CurlRuntime throws curl.CURLcode {
    try curl.curl_global_init();
    return CurlRuntime({});
}

function fetchHosts(): void throws curl.CURLcode {
    const runtime = try initializeCurl();
    const easy = curl.curl_easy_init();
    if (easy == null) {
        throw curl.CURLE_FAILED_INIT;
    }

    try curl.curl_easy_setopt(
        easy,
        curl.CURLOPT_URL,
        "file:///etc/hosts"
    );
    try curl.curl_easy_perform(easy);
}

function main(): i32 {
    return match (attempt fetchHosts()) {
        success => 0;
        failure(error) => {
            console.log(error);
            select 1;
        }
    };
}
