# netlify/functions/upload.py

import json
import requests
import time
from requests_toolbelt.multipart import decoder

def poll_operation(api_key, operation_id):
    """
    Fungsi untuk polling status operasi Roblox hingga selesai.
    """
    url = f"https://apis.roblox.com/assets/v1/operations/{operation_id}"
    headers = {"x-api-key": api_key}
    start_time = time.time()
    timeout = 120  # Timeout 2 menit

    while (time.time() - start_time) < timeout:
        try:
            response = requests.get(url, headers=headers)
            response.raise_for_status()
            data = response.json()
            if data.get("done"):
                return data
        except requests.exceptions.RequestException as e:
            print(f"Error saat polling: {e}")
        
        time.sleep(3)
    return None

def handler(event, context):
    """
    Handler utama untuk Netlify Function.
    """
    try:
        # Hanya menerima method POST
        if event["httpMethod"] != "POST":
            return {
                "statusCode": 405,
                "body": json.dumps({"status": "error", "message": "Metode tidak diizinkan."})
            }

        # Mengurai body multipart/form-data
        content_type = event["headers"].get("content-type")
        if not content_type:
            return {
                "statusCode": 400,
                "body": json.dumps({"status": "error", "message": "Content-Type header tidak ditemukan."})
            }

        body = event["body"]
        if event["isBase64Encoded"]:
            body = requests.utils.to_native_string(body)
        
        multipart_data = decoder.MultipartDecoder(body.encode('utf-8'), content_type)

        fields = {}
        files = {}
        for part in multipart_data.parts:
            headers = part.headers
            content_disposition = headers.get(b'Content-Disposition', b'').decode('utf-8')
            
            # Ekstrak nama field
            name_match = requests.utils.parse_header_links(f'<{content_disposition}>')
            name = name_match[0]['params']['name']

            # Jika ini adalah file
            if 'filename' in name_match[0]['params']:
                files[name] = {
                    "filename": name_match[0]['params']['filename'],
                    "content_type": headers.get(b'Content-Type', b'').decode('utf-8'),
                    "data": part.content
                }
            # Jika ini adalah field biasa
            else:
                fields[name] = part.content.decode('utf-8')

        api_key = fields.get("apiKey")
        user_id = fields.get("userId")
        display_name = fields.get("displayName")
        description = fields.get("description")
        file_content = files.get("fileContent")

        if not all([api_key, user_id, file_content]):
            return {
                "statusCode": 400,
                "body": json.dumps({"status": "error", "message": "API Key, User ID, atau file tidak ada."})
            }

        # Buat permintaan unggahan ke API Roblox
        roblox_form_data = FormData()
        request_payload = {
            "assetType": "TShirt",
            "displayName": display_name,
            "description": description,
            "creationContext": {"creator": {"userId": int(user_id)}}
        }

        roblox_form_data.add_field("request", json.dumps(request_payload),
                                  content_type='application/json')
        roblox_form_data.add_field("fileContent", file_content["data"],
                                  filename=file_content["filename"],
                                  content_type=file_content["content_type"])
        
        roblox_headers = {
            "x-api-key": api_key,
            **roblox_form_data.headers
        }

        upload_res = requests.post("https://apis.roblox.com/assets/v1/assets",
                                   headers=roblox_headers,
                                   data=roblox_form_data)
        
        upload_data = upload_res.json()

        if upload_res.status_code != 200 or not upload_data.get("operationId"):
            return {
                "statusCode": upload_res.status_code,
                "body": json.dumps({
                    "status": "error",
                    "message": "Gagal memulai unggahan ke Roblox.",
                    "robloxResponse": upload_data
                })
            }
        
        # Polling status operasi
        poll_result = poll_operation(api_key, upload_data["operationId"])

        if poll_result and poll_result.get("response") and poll_result["response"].get("assetId"):
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "status": "success",
                    "message": "Unggahan berhasil!",
                    "assetId": poll_result["response"]["assetId"],
                    "operationId": upload_data["operationId"],
                    "name": display_name,
                    "description": description
                })
            }
        else:
            return {
                "statusCode": 500,
                "body": json.dumps({
                    "status": "error",
                    "message": "Gagal menyelesaikan unggahan (timeout atau error polling).",
                    "robloxPollingResponse": poll_result
                })
            }

    except Exception as e:
        print(f"Error tak terduga: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"status": "error", "message": str(e)})
        }

