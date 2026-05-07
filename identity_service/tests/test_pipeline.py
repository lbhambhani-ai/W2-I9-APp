import unittest

from identity_service.pipeline import (
    analyze_ocr_text,
    assess_image_quality,
    detect_document_type,
    normalize_date,
    parse_aamva_fields,
    parse_mrz,
    verify_image_payload,
)


PROFILE = {
    "legalFirstName": "Lakshya",
    "legalMiddleName": "",
    "legalLastName": "Bhambhani",
    "dateOfBirth": "2003-09-15",
    "addressLine1": "895 Main St",
    "city": "San Francisco",
    "state": "CA",
    "zip": "94105",
}


def png_data_url(image) -> str:
    import base64
    import cv2

    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise AssertionError("Could not encode test image")
    return "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def low_quality_test_image():
    import cv2
    import numpy as np

    image = np.full((150, 240, 3), 168, dtype=np.uint8)
    cv2.rectangle(image, (20, 25), (220, 125), (178, 178, 178), -1)
    cv2.putText(image, "PASSPORT", (40, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (145, 145, 145), 1)
    cv2.putText(image, "EXEMPLAR", (55, 88), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (148, 148, 148), 1)
    return cv2.GaussianBlur(image, (13, 13), 0)


def clean_quality_test_image():
    import cv2
    import numpy as np

    image = np.full((360, 560, 3), 245, dtype=np.uint8)
    cv2.rectangle(image, (30, 45), (530, 315), (255, 255, 255), -1)
    cv2.rectangle(image, (30, 45), (530, 315), (10, 10, 10), 4)
    cv2.putText(image, "UNITED STATES PASSPORT CARD", (55, 95), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2)
    cv2.putText(image, "SUSAN EXEMPLAR", (75, 170), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    cv2.putText(image, "01 JAN 1981", (75, 230), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2)
    cv2.putText(image, "29 NOV 2031", (75, 285), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2)
    return image


def low_resolution_test_image():
    import cv2
    import numpy as np

    image = np.full((150, 240, 3), 245, dtype=np.uint8)
    cv2.rectangle(image, (8, 12), (232, 138), (255, 255, 255), -1)
    cv2.rectangle(image, (8, 12), (232, 138), (10, 10, 10), 2)
    cv2.putText(image, "UNITED STATES", (20, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 0), 1)
    cv2.putText(image, "PASSPORT CARD", (20, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 1)
    cv2.putText(image, "SUSAN EXEMPLAR", (20, 85), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 1)
    cv2.putText(image, "1 JAN 1981", (20, 112), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 0), 1)
    return image


class IdentityPipelineTest(unittest.TestCase):
    def test_detects_permanent_resident_card_from_text(self):
        text = """
        UNITED STATES OF AMERICA
        PERMANENT RESIDENT
        Surname SPECIMEN
        Given Name TEST V
        USCIS# A123456789
        Date of Birth 20 OCT 2002
        Card Expires 10/26/32
        Category IR1
        """

        self.assertEqual(detect_document_type(text), "permanent-resident-card")

    def test_rejects_wrong_name_and_dob_for_green_card(self):
        result = analyze_ocr_text(
            """
            UNITED STATES OF AMERICA
            PERMANENT RESIDENT
            Surname SPECIMEN
            Given Name TEST V
            USCIS# A123456789
            Date of Birth 20 OCT 2002
            Card Expires 10/26/32
            Category IR1
            """,
            selected_document_type="permanent-resident-card",
            document_side="front",
            profile=PROFILE,
            request_id="req_green_card",
        )

        self.assertTrue(result["analysis"]["documentDetected"])
        self.assertEqual(result["analysis"]["detectedDocumentType"], "permanent-resident-card")
        self.assertFalse(result["analysis"]["complianceEligibility"])
        self.assertIn("NAME_MISMATCH", [flag["code"] for flag in result["analysis"]["flags"]])
        self.assertIn("DOB_MISMATCH", [flag["code"] for flag in result["analysis"]["flags"]])
        self.assertIn("name and date of birth do not match", result["userMessage"])

    def test_green_card_ignores_dob_bleed_in_surname_and_parses_dob_before_sex(self):
        result = analyze_ocr_text(
            """
            UNItED States OF AmerIca PERMANENT RESIDENT
            Surname 29 FE A AHMAD Given Name AHMAD M UscIS# Category 058-244-501 SE3
            Country of Birth Jordan Date of Birth Sex 29 FEB 2000 M
            Card Expires: 04/11/24 Resident Since: 04/11/14 Ak Ahhad 200 J mad
            """,
            selected_document_type="permanent-resident-card",
            document_side="front",
            profile={
                **PROFILE,
                "legalFirstName": "Ahmad",
                "legalMiddleName": "M",
                "legalLastName": "Ahmad",
                "dateOfBirth": "2000-02-29",
            },
            request_id="req_green_card_ahmad",
        )

        fields = result["analysis"]["extractedFields"]
        codes = [flag["code"] for flag in result["analysis"]["flags"]]
        self.assertEqual(fields["last_name"], "AHMAD")
        self.assertEqual(fields["first_name"], "AHMAD")
        self.assertEqual(fields["middle_name"], "M")
        self.assertEqual(fields["date_of_birth"], "2000-02-29")
        self.assertEqual(fields["expiration_date"], "2024-04-11")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "EXPIRED")
        self.assertNotIn("NAME_MISMATCH", codes)
        self.assertNotIn("DOB_NOT_EXTRACTED", codes)

    def test_extracts_noisy_employment_authorization_card_front(self):
        result = analyze_ocr_text(
            """
            FULL NAME MSUREEN CATEGORY SEX UNITED STATES 0F AMERICA
            JEHPLOVTENT AUTHORIZERICA Surname AKABUEZE Given Name MSUREEN 0
            UsciS# Category Card# 216-948-537 C08 I0E0924932981
            Terms and Conditions None Date of Birlh Sex 28 NOV 1996
            Country of Birth Nigeria Valid From; 05129/24
            Card Expires: 05/28/29
            """,
            selected_document_type="employment-authorization-card",
            document_side="front",
            profile={
                **PROFILE,
                "legalFirstName": "Maureen",
                "legalMiddleName": "Onyine",
                "legalLastName": "Akabueze",
                "dateOfBirth": "1996-11-28",
            },
            request_id="req_ead_front",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(result["analysis"]["detectedDocumentType"], "employment-authorization-card")
        self.assertEqual(result["analysis"]["detectedSide"], "front")
        self.assertEqual(fields["last_name"], "AKABUEZE")
        self.assertEqual(fields["first_name"], "MAUREEN")
        self.assertEqual(fields["date_of_birth"], "1996-11-28")
        self.assertEqual(fields["expiration_date"], "2029-05-28")
        self.assertEqual(fields["category"], "C08")
        self.assertEqual(fields["a_number"], "216948537")
        self.assertEqual(fields["card_number"], "IOE0924932981")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_extracts_employment_authorization_card_back_mrz(self):
        result = analyze_ocr_text(
            """
            This card is not evidence of U.S. citizenship or permanent residence
            IAUSA2169485377IOE0924932981<9
            9611283F2905280NGA<<<<<<<<<<<9
            AKABUEZE<<MAUREEN<ONYINE<<<<<<
            """,
            selected_document_type="employment-authorization-card",
            document_side="back",
            profile={
                **PROFILE,
                "legalFirstName": "Maureen",
                "legalMiddleName": "Onyine",
                "legalLastName": "Akabueze",
                "dateOfBirth": "1996-11-28",
            },
            request_id="req_ead_back",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(result["analysis"]["detectedDocumentType"], "employment-authorization-card")
        self.assertEqual(result["analysis"]["detectedSide"], "back")
        self.assertEqual(fields["last_name"], "AKABUEZE")
        self.assertEqual(fields["first_name"], "MAUREEN")
        self.assertEqual(fields["middle_name"], "ONYINE")
        self.assertEqual(fields["date_of_birth"], "1996-11-28")
        self.assertEqual(fields["expiration_date"], "2029-05-28")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertNotIn("SIDE_MISMATCH", [flag["code"] for flag in result["analysis"]["flags"]])

    def test_rejects_non_id_text(self):
        result = analyze_ocr_text(
            "watch arm ceiling lights office not an identity document",
            selected_document_type="state-id",
            document_side="front",
            profile=PROFILE,
            request_id="req_non_id",
        )

        self.assertFalse(result["analysis"]["documentDetected"])
        self.assertEqual(result["analysis"]["nextAction"], "RETAKE_PHOTO")
        self.assertIn("NO_DOCUMENT_DETECTED", [flag["code"] for flag in result["analysis"]["flags"]])

    def test_normalizes_common_date_formats(self):
        self.assertEqual(normalize_date("20 OCT 2002"), "2002-10-20")
        self.assertEqual(normalize_date("10/26/32"), "2032-10-26")
        self.assertEqual(normalize_date("09/15/2003"), "2003-09-15")

    def test_parses_basic_passport_mrz(self):
        mrz = parse_mrz(
            "P<USABHAMBHANI<<LAKSHYA<<<<<<<<<<<<<<<<<<<<<<<\n"
            "1234567897USA0309159M3004159<<<<<<<<<<<<<<06"
        )

        self.assertEqual(mrz["last_name"], "BHAMBHANI")
        self.assertEqual(mrz["first_name"], "LAKSHYA")
        self.assertEqual(mrz["date_of_birth"], "2003-09-15")
        self.assertEqual(mrz["document_number"], "123456789")

    def test_parses_inline_passport_mrz_from_ocr_text(self):
        mrz = parse_mrz(
            "P<USAABBASI<<MUHAMMAD<ABDULLAH<<<<<<<<<<<<<< "
            "4694975406USA0407090M3506226357370274<600444"
        )

        self.assertEqual(mrz["last_name"], "ABBASI")
        self.assertEqual(mrz["first_name"], "MUHAMMAD")
        self.assertEqual(mrz["middle_name"], "ABDULLAH")
        self.assertEqual(mrz["date_of_birth"], "2004-07-09")
        self.assertEqual(mrz["expiration_date"], "2035-06-22")
        self.assertEqual(mrz["document_number"], "469497540")

    def test_us_passport_front_uses_mrz_when_label_ocr_is_noisy(self):
        result = analyze_ocr_text(
            """
            Mk eaae Waa Bsspori 'E UMANED SIXY ONAMLRUCA USA A69497560 U8a ABBASI
            MUHAMMAD ABDULLAH UNITED STATES OF AneiC Dats 09 JUL 2004 PAKISTAN
            23 JUN 2025 22 JUN 2035 united StaTES Departvent 05 State
            P<USAABBASI<<muhAMMAD<ABDULLAH<<< << < < < << < < < <
            4694975406us40407090m3506226357370274<600444
            """,
            selected_document_type="passport",
            document_side="front",
            profile={
                **PROFILE,
                "legalFirstName": "Muhammad",
                "legalMiddleName": "Abdullah",
                "legalLastName": "Abbasi",
                "dateOfBirth": "2004-07-09",
            },
            request_id="req_us_passport_front",
        )

        self.assertEqual(result["analysis"]["detectedDocumentType"], "passport")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_us_passport_book_is_not_misclassified_as_passport_card(self):
        result = analyze_ocr_text(
            """
            SIGNATURE OF BEARER PASSPORT THE UNITED STATES OF AMERICA
            Passport No A53707362 Surname ADAME Given names MARIO EDUARDO
            UNITED STATES OF AMERICA Date of birth 12 JUL 2000 Sex M
            Place of birth ARIZONA, USA Date of issue 23 OCT 2024
            Date of expiration 22 OCT 2034 UNITED STATES DEPARTMENT OF STATE
            P<USAADAME<<MARIO<EDUARDO<<<<<<<<<<<<<<<<<<<
            A537073625USA0007124M3410222355773126<081666
            """,
            selected_document_type="passport",
            document_side="front",
            profile={
                **PROFILE,
                "legalFirstName": "Mario",
                "legalMiddleName": "Eduardo",
                "legalLastName": "Adame",
                "dateOfBirth": "2000-07-12",
            },
            request_id="req_us_passport_book_adame",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(result["analysis"]["detectedDocumentType"], "passport")
        self.assertEqual(fields["last_name"], "ADAME")
        self.assertEqual(fields["first_name"], "MARIO")
        self.assertEqual(fields["middle_name"], "EDUARDO")
        self.assertEqual(fields["date_of_birth"], "2000-07-12")
        self.assertEqual(fields["expiration_date"], "2034-10-22")
        self.assertEqual(fields["document_number"], "A53707362")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_us_passport_book_uses_mrz_before_false_aamva_text(self):
        result = analyze_ocr_text(
            """
            SIGNATURE OF BEARER SIGNATURE DU TITULAIRE FIRMA DEL TITULAR
            PASSPORT THE UNITED STATES OF AMERICA Type P Code USA Passport No A53707362
            Surname ADAME Given Names MARIO EDUARDO UNITED STATES OF AMERICA
            Date of birth 12 JUL 2000 Place of birth ARIZONA, USA Date of issue 23 OCT 2024
            Date of expiration 22 OCT 2034 Runonity Wonnaulondad UNITED STATES DEPARTMENT OF STATE
            P<USAADAME<<MARIO<EDUARDO<<<<<<<<<<<<<<<<<<<
            A537073625USA0007124M3410222355773126<081666
            """,
            selected_document_type="passport",
            document_side="front",
            profile={
                **PROFILE,
                "legalFirstName": "Mario",
                "legalMiddleName": "Eduardo",
                "legalLastName": "Adame",
                "dateOfBirth": "2000-07-12",
            },
            request_id="req_us_passport_false_aamva",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(result["analysis"]["detectedDocumentType"], "passport")
        self.assertEqual(fields["last_name"], "ADAME")
        self.assertEqual(fields["first_name"], "MARIO")
        self.assertEqual(fields["middle_name"], "EDUARDO")
        self.assertEqual(fields["date_of_birth"], "2000-07-12")
        self.assertEqual(fields["expiration_date"], "2034-10-22")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_us_passport_book_chooses_valid_mrz_from_noisy_ocr_passes(self):
        text = """
        SIGNATURE OF BEARER SIGNATURE DU TITULAIRE FIRMA DEL TITULAR PASSPORT
        TEE UNHTED SEHES OF AMRICA Cndercoducano Ratenun WerTyna A60072935 USA
        innllio AHIO bret CHIARA LOSA UNITED STATES OF AMErica 24 FEB 2008 Usie UTAH US.A
        Daic 31 MAR 2025 n 30 MAR 2035 Auhont united STATES DEPARTMENT OF STATE
        P<USAAHIO<<CHIARA<LOSA<<<<<<<<<<<<<<<<<<<<< <
        4600729358u540802248F3503306624994725<101224
        SIGNATURE OF BEARER PASSPORT TEE UNHND STAES OF AMRICA A60072935 USA
        AHIO CHIARA LOSA UNITED STATES OF AMERICA 24 FEB 2008 UTAH USA
        31 MAR 2025 30 MAR 2035 UNITED STATES DEPARTMENT OF STATE
        P<USAAHIO<<CHIARA<LOSA<<<<<<<<<<<<<<<<<<<<< <
        A600729358u540802248F3503306624994725<101224
        """
        result = analyze_ocr_text(
            text,
            selected_document_type="passport",
            document_side="front",
            profile={
                **PROFILE,
                "legalFirstName": "Chiara",
                "legalMiddleName": "Losa",
                "legalLastName": "Ahio",
                "dateOfBirth": "2008-02-24",
            },
            request_id="req_us_passport_book_ahio",
        )

        mrz = parse_mrz(text)
        fields = result["analysis"]["extractedFields"]
        self.assertEqual(result["analysis"]["detectedDocumentType"], "passport")
        self.assertEqual(mrz["document_number"], "A60072935")
        self.assertEqual(fields["last_name"], "AHIO")
        self.assertEqual(fields["first_name"], "CHIARA")
        self.assertEqual(fields["middle_name"], "LOSA")
        self.assertEqual(fields["date_of_birth"], "2008-02-24")
        self.assertEqual(fields["expiration_date"], "2035-03-30")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_us_passport_back_visa_page_is_recognized_as_supporting_side(self):
        result = analyze_ocr_text(
            "L~ 1 4 TuudmnkmtnrOl 4'eea Rnyo^ d-Ibt&u-4lr_nrdd vny brthnz cluunnh: Mar/aJot 5 A 6 9 4 9 7 5 4 0 Visas 5 0",
            selected_document_type="passport",
            document_side="back",
            profile={
                **PROFILE,
                "legalFirstName": "Muhammad",
                "legalMiddleName": "Abdullah",
                "legalLastName": "Abbasi",
                "dateOfBirth": "2004-07-09",
            },
            request_id="req_us_passport_back",
        )

        self.assertTrue(result["analysis"]["documentDetected"])
        self.assertEqual(result["analysis"]["detectedDocumentType"], "passport")
        self.assertEqual(result["analysis"]["documentTypeMatch"], True)
        self.assertNotIn("NO_DOCUMENT_DETECTED", [flag["code"] for flag in result["analysis"]["flags"]])

    def test_passport_card_ocr_with_noisy_labels_still_matches_profile(self):
        result = analyze_ocr_text(
            """
            UNITED STATES OF AMERICA PASSPORT CARD Sumtanie Passpo BHAMBHANI
            Given Names LAKSHYA Passport Card No 23456789 Nalionallly Place of Birui USA
            Dale Birth 15 SEP 2003 San Francisco, CA, USA Sex Date of Issue
            Date of Expiraticn Bhanban 20 OCT 2022 20 OCT 2032 Jakshaya
            """,
            selected_document_type="passport-card",
            document_side="front",
            profile=PROFILE,
            request_id="req_passport_card",
        )

        self.assertEqual(result["analysis"]["detectedDocumentType"], "passport-card")
        self.assertTrue(result["analysis"]["complianceEligibility"])
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_real_passport_card_format_with_noisy_ocr_is_detected_and_parsed(self):
        result = analyze_ocr_text(
            """
            UNITED STATES OF AMIERICA pabuport CARo Pbstesacaicn0 e USA C03005988 :
            Ked EXEMPLAR TraVeLER 2 678o8 Happy 1 oel K Jan 1981 Fedenr NeyYork US A
            8n64 30 Noy 2009 29 Noy 2017 7061310z1.07 70i)
            Uniteo Otatro oepaatniNT 0r Ot
            """,
            selected_document_type="passport-card",
            document_side="front",
            profile={
                **PROFILE,
                "legalFirstName": "Susan",
                "legalMiddleName": "Traveler",
                "legalLastName": "Exemplar",
                "dateOfBirth": "1981-01-01",
            },
            request_id="req_real_passport_card",
        )

        self.assertTrue(result["analysis"]["documentDetected"])
        self.assertEqual(result["analysis"]["detectedDocumentType"], "passport-card")
        self.assertEqual(result["analysis"]["extractedFields"]["last_name"], "EXEMPLAR")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "NOT_CHECKED")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "EXPIRED")

    def test_image_quality_detects_confident_low_quality_without_flagging_clean_images(self):
        low_quality = assess_image_quality(png_data_url(low_quality_test_image()))
        clean_quality = assess_image_quality(png_data_url(clean_quality_test_image()))

        self.assertTrue(low_quality["isLowQuality"])
        self.assertGreaterEqual(low_quality["confidence"], 0.8)
        self.assertIn("LOW_SHARPNESS", low_quality["reasons"])
        self.assertIn("LOW_CONTRAST", low_quality["reasons"])

        self.assertFalse(clean_quality["isLowQuality"])
        self.assertLess(clean_quality["confidence"], 0.8)

    def test_quality_detects_very_low_resolution_even_when_edges_are_sharp(self):
        quality = assess_image_quality(png_data_url(low_resolution_test_image()))

        self.assertTrue(quality["isLowQuality"])
        self.assertGreaterEqual(quality["confidence"], 0.8)
        self.assertIn("LOW_RESOLUTION", quality["reasons"])

    def test_verifier_shows_low_quality_message_only_when_confidence_is_high(self):
        payload = {
            "requestId": "req_low_quality",
            "ocrText": "UNITED STATES OF AMERICA PASSPORT CARD EXEMPLAR TRAVELER DATE OF BIRTH 1 JAN 1981 DATE OF EXPIRATION 29 NOV 2031",
            "selectedDocumentType": "passport-card",
            "documentSide": "front",
            "profile": {
                **PROFILE,
                "legalFirstName": "Susan",
                "legalLastName": "Exemplar",
                "dateOfBirth": "1981-01-01",
            },
        }
        low_quality_result = verify_image_payload({
            **payload,
            "imageBase64": png_data_url(low_quality_test_image()),
        })
        clean_result = verify_image_payload({
            **payload,
            "requestId": "req_clean_partial",
            "imageBase64": png_data_url(clean_quality_test_image()),
        })

        self.assertIn("IMAGE_QUALITY_LOW", [flag["code"] for flag in low_quality_result["analysis"]["flags"]])
        self.assertIn("low quality", low_quality_result["userMessage"].lower())
        self.assertNotIn("IMAGE_QUALITY_LOW", [flag["code"] for flag in clean_result["analysis"]["flags"]])

    def test_parses_aamva_back_barcode_fields(self):
        fields = parse_aamva_fields("ANSI 636000080002DL00410288ZA03290015DLDAQD1234567\nDCSBHAMBHANI\nDACLAKSHYA\nDADK\nDBB20030915\nDBA20300415")

        self.assertEqual(fields["last_name"], "BHAMBHANI")
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["date_of_birth"], "2003-09-15")
        self.assertEqual(fields["expiration_date"], "2030-04-15")

    def test_rejects_back_barcode_uploaded_to_front_slot(self):
        result = analyze_ocr_text(
            "ANSI 636000080002DL00410288ZA03290015DLDAQD1234567\nDCSBHAMBHANI\nDACLAKSHYA\nDADK\nDBB20030915\nDBA20300415",
            selected_document_type="drivers-license",
            document_side="front",
            profile=PROFILE,
            request_id="req_back_in_front_slot",
        )

        self.assertEqual(result["analysis"]["detectedSide"], "back")
        self.assertIn("SIDE_MISMATCH", [flag["code"] for flag in result["analysis"]["flags"]])
        self.assertFalse(result["analysis"]["complianceEligibility"])
        self.assertEqual(result["analysis"]["nextAction"], "REQUEST_FRONT_IMAGE")
        self.assertIn("back side", result["userMessage"])

    def test_rejects_front_id_uploaded_to_back_slot(self):
        result = analyze_ocr_text(
            """
            Texas USA
            Texas STATE IDENTIFICATION CARD The Lone Star State
            4d. ID NUMBER 12345678 3. DOB 1.NAME 09/17/2003 LAKSHYA BHAMBHANI
            8. ADDRESS 1234 MAIN ST AUSTIN, TX 78701
            4a. ISSUED 4b. EXPIRES 05/20/2024 05/20/2032
            """,
            selected_document_type="state-id",
            document_side="back",
            profile={**PROFILE, "dateOfBirth": "2003-09-17"},
            request_id="req_front_in_back_slot",
        )

        self.assertEqual(result["analysis"]["detectedSide"], "front")
        self.assertIn("SIDE_MISMATCH", [flag["code"] for flag in result["analysis"]["flags"]])
        self.assertFalse(result["analysis"]["complianceEligibility"])
        self.assertEqual(result["analysis"]["nextAction"], "REQUEST_BACK_IMAGE")
        self.assertIn("front side", result["userMessage"])

    def test_generic_extraction_does_not_fall_back_to_profile_values(self):
        result = analyze_ocr_text(
            "DRIVER LICENSE DOB 09/15/2003",
            selected_document_type="drivers-license",
            document_side="front",
            profile=PROFILE,
            request_id="req_no_name",
        )

        self.assertNotIn("first_name", result["analysis"]["extractedFields"])
        self.assertIn("NAME_NOT_EXTRACTED", [flag["code"] for flag in result["analysis"]["flags"]])

    def test_extracts_california_ln_fn_driver_license_layout(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-17"}
        result = analyze_ocr_text(
            """
            CALIFORNA DRIVER LICENSE
            BHAMBHANI LAKSHYA (LNIFN) DL No: B3456789 789 OAK AVENUE SAN FRANCISCO, CA 94118
            DOB: 09/17/2003 Sex: M WGT: 160 lb HGT: 5'-09" HAIR: BLK EYES: BRN
            Issued: 10/12/2022 Expires: 09/17/2028
            """,
            selected_document_type="drivers-license",
            document_side="front",
            profile=profile,
            request_id="req_ca_dl",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["last_name"], "BHAMBHANI")
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["date_of_birth"], "2003-09-17")
        self.assertEqual(fields["expiration_date"], "2028-09-17")
        self.assertEqual(fields["document_number"], "B3456789")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")
        self.assertNotIn("NAME_NOT_EXTRACTED", [flag["code"] for flag in result["analysis"]["flags"]])

    def test_extracts_massachusetts_numbered_driver_license_layout(self):
        profile = {
            **PROFILE,
            "legalFirstName": "Amir",
            "legalMiddleName": "Khikmatovich",
            "legalLastName": "Abdujabbarov",
            "dateOfBirth": "1996-01-29",
            "addressLine1": "490 Union St Apt 25",
            "city": "Rockland",
            "state": "MA",
            "zip": "02370",
        }
        result = analyze_ocr_text(
            """
            MASSACHUSETTS DRIVER'S LiCENSE NOT FOR FEDERAL ID 46S 40 MJHEER
            05/22/2024 SA5791430 46 EXP DOB 01/29/2029 01429/1996 CLASS
            12 REST 9a END NONE NONE 1 ARRRHIKMAFOVCROV 490 UNION ST APT 25
            ROCKLAND, MA 02370-1748
            MASSACHUSETTS DRIVER'S LicENSE NOT FOR FEDERAL ID 3ER 05/22/2024
            SA5791430 3 7 01/29/2029 01n29/1996 CLASS REST E NONE NONE
            1 ABDUJABBAROV AMIR KHIKMATOVICH 2 490 UNION ST APT 25
            ROCKLAND, MA 02370-1748 18 EYES BRO SEX M 16HCT 5'.10"
            01/29/96 DD 05/222024 Rev 0222 2016
            """,
            selected_document_type="drivers-license",
            document_side="front",
            profile=profile,
            request_id="req_ma_dl",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["last_name"], "ABDUJABBAROV")
        self.assertEqual(fields["first_name"], "AMIR")
        self.assertEqual(fields["middle_name"], "KHIKMATOVICH")
        self.assertEqual(fields["date_of_birth"], "1996-01-29")
        self.assertEqual(fields["issue_date"], "2024-05-22")
        self.assertEqual(fields["expiration_date"], "2029-01-29")
        self.assertEqual(fields["document_number"], "SA5791430")
        self.assertEqual(fields["address_line1"], "490 UNION ST APT 25")
        self.assertEqual(fields["city"], "ROCKLAND")
        self.assertEqual(fields["state"], "MA")
        self.assertEqual(fields["zip"], "02370-1748")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_extracts_tennessee_temporary_driver_license_layout(self):
        profile = {
            **PROFILE,
            "legalFirstName": "Mehary",
            "legalMiddleName": "R",
            "legalLastName": "Achiso",
            "dateOfBirth": "2002-05-14",
            "addressLine1": "3001 Hamilton Church Rd Unit 306",
            "city": "Antioch",
            "state": "TN",
            "zip": "37013",
        }
        result = analyze_ocr_text(
            """
            TENNESSEE: VOLUNTEER STATE THE TEMPORARY DRIVER LICENSE
            AcHas? _ ARMRoN CHURCH RD 3001 into8h; 306 TN 37013-7401
            DL NO. 159178095 DOB '05/14/2002 EXP 10/28/2033 ISS 10/28/2025
            REST NONE CLASS XD END NONE 020514 SEX HGT 5'-07" EYES BLK
            TENNESSEE: VOLUNTEER STATE THE TEMPORARY DRIVER LICENSE
            acHas? _ RoN CHURCH RD 3001 HAMIL into8h; 306 TN 37013-7401
            DL NO. 159178095 DOB 05/14/2002 EXP 10/28/2033 ISS 10/28/2025
            """,
            selected_document_type="drivers-license",
            document_side="front",
            profile=profile,
            request_id="req_tn_temp_dl",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["last_name"], "ACHISO")
        self.assertEqual(fields["first_name"], "MEHARY")
        self.assertEqual(fields["middle_name"], "R")
        self.assertEqual(fields["date_of_birth"], "2002-05-14")
        self.assertEqual(fields["issue_date"], "2025-10-28")
        self.assertEqual(fields["expiration_date"], "2033-10-28")
        self.assertEqual(fields["document_number"], "159178095")
        self.assertEqual(fields["address_line1"], "3001 HAMILTON CHURCH RD UNIT 306")
        self.assertEqual(fields["city"], "ANTIOCH")
        self.assertEqual(fields["state"], "TN")
        self.assertEqual(fields["zip"], "37013-7401")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_extracts_indiana_operator_license_layout(self):
        profile = {
            **PROFILE,
            "legalFirstName": "Walter",
            "legalMiddleName": "Martin",
            "legalLastName": "Adkins",
            "dateOfBirth": "1979-04-24",
            "addressLine1": "506 Grant St",
            "city": "Lagrange",
            "state": "IN",
            "zip": "46761",
        }
        text = """
        INDIANA USA OPERATOR LICENSE a NCoe cotaSSOneR d DLN 0780-25-7864
        40 EXP 04/24/2027 ADKINS WALTER MARTIN, JR 506 GRANT ST LAGRANGE IN 46761
        CIASS NONE 9a END 2 12 RES B 16 SEX M 16 KGT 6'-00" 1T WGT 290 Ib
        18 EYES GRN 19 HAIR BRO DOB 04/24/1979 - 4a /SS 05/15/2020
        2 ahbal DO 05152037800007 DONOR 04/24/79
        """
        result = analyze_ocr_text(
            text,
            selected_document_type="drivers-license",
            document_side="front",
            profile=profile,
            request_id="req_indiana_operator_license",
        )

        self.assertEqual(detect_document_type(text), "drivers-license")
        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["last_name"], "ADKINS")
        self.assertEqual(fields["first_name"], "WALTER")
        self.assertEqual(fields["middle_name"], "MARTIN")
        self.assertEqual(fields["date_of_birth"], "1979-04-24")
        self.assertEqual(fields["expiration_date"], "2027-04-24")
        self.assertEqual(fields["issue_date"], "2020-05-15")
        self.assertEqual(fields["document_number"], "0780-25-7864")
        self.assertEqual(fields["address_line1"], "506 GRANT ST")
        self.assertEqual(fields["city"], "LAGRANGE")
        self.assertEqual(fields["state"], "IN")
        self.assertEqual(fields["zip"], "46761")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_extracts_south_carolina_not_a_drivers_license_state_id(self):
        profile = {
            **PROFILE,
            "legalFirstName": "Kenyana",
            "legalMiddleName": "Jemeria",
            "legalLastName": "Allen",
            "dateOfBirth": "1994-10-29",
            "addressLine1": "129 Morning Line Dr",
            "city": "Moncks Corner",
            "state": "SC",
            "zip": "29461",
        }
        text = """
        ID South Caraa KnCaro ADL: {04979132 ALLEI KENYANA JEMERIA
        1 Moncor Corher DR 294816512 DOB: 10/29/1994 Ussued: 09/04/2025
        Mm Expires: 09/04/2033 hettna S0x Hgt: 5*-01" Wot; 420 Ib 18 Eyes: BRO
        NOT A ORIVER'S ICERSEROHA AR-E 6D 080068010038262924J Cov?
        FaO 0 South Caraae DL: [04979132 ALLE 8 KENYANA JEMERIA
        129 VORNING LINE DR MONCKS CORNER SC 294016512 8 DOB: 40/9/1994
        ssued: 09/04/2025 mM Expires 09/04/2033
        """
        result = analyze_ocr_text(
            text,
            selected_document_type="state-id",
            document_side="front",
            profile=profile,
            request_id="req_sc_state_id",
        )

        self.assertEqual(detect_document_type(text), "state-id")
        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["last_name"], "ALLEN")
        self.assertEqual(fields["first_name"], "KENYANA")
        self.assertEqual(fields["middle_name"], "JEMERIA")
        self.assertEqual(fields["date_of_birth"], "1994-10-29")
        self.assertEqual(fields["issue_date"], "2025-09-04")
        self.assertEqual(fields["expiration_date"], "2033-09-04")
        self.assertEqual(fields["document_number"], "04979132")
        self.assertEqual(fields["address_line1"], "129 MORNING LINE DR")
        self.assertEqual(fields["city"], "MONCKS CORNER")
        self.assertEqual(fields["state"], "SC")
        self.assertEqual(fields["zip"], "29461")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_extracts_georgia_state_id_name_from_numbered_layout(self):
        profile = {
            **PROFILE,
            "legalFirstName": "Shantika",
            "legalMiddleName": "Shanae",
            "legalLastName": "Anderson",
            "dateOfBirth": "1989-09-28",
        }
        text = """
        USA GEORGIA ID GA IDENTIFICATION CARD IDENTIFICATION CARD
        4d ID NO. 058915258 DOB 09/28/1989 4b EXP 09/28/2029
        SHANTIKA SHANAE ANDERSON 3384 MOUNT ZION RD APT 1104
        STOCKBRIDGE, GA 30281-7860 CLAYTON 1 4a ISS 11/19/2025
        """
        result = analyze_ocr_text(
            text,
            selected_document_type="state-id",
            document_side="front",
            profile=profile,
            request_id="req_ga_state_id_name",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(result["analysis"]["detectedDocumentType"], "state-id")
        self.assertEqual(fields["first_name"], "SHANTIKA")
        self.assertEqual(fields["middle_name"], "SHANAE")
        self.assertEqual(fields["last_name"], "ANDERSON")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")

    def test_targeted_name_ocr_wins_over_noisy_full_card_read(self):
        result = analyze_ocr_text(
            """
            FULL NAME LAKSHYA BHAMBANI SEX
            CALIFORNIA DRIVER LICEFUS EUME C12345678 FULL FUAKSHYA BHAMBANI SEX DATE BF M
            09/17/2003 04/30/2026 09/17/2031 EXPIRATIN DAATE
            """,
            selected_document_type="drivers-license",
            document_side="front",
            profile={**PROFILE, "dateOfBirth": "2003-09-17"},
            request_id="req_ca_targeted_name",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["last_name"], "BHAMBANI")
        self.assertEqual(fields["date_of_birth"], "2003-09-17")

    def test_extracts_state_id_name_real_id_layout(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-17"}
        result = analyze_ocr_text(
            """
            STATE OF [Generic State Name] IDENTIFICATION CARD
            Name REAL ID LAKSHYA BHAMBHANI 1234 MAPLE AVENUE APARTMENT 2B SACRAMENTO, CA 95814
            DOB: 09/17/2003
            ID Number: D9876543
            ISS: 10/20/2022 EXP: 09/17/2027
            """,
            selected_document_type="state-id",
            document_side="front",
            profile=profile,
            request_id="req_state_id_real_id",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["last_name"], "BHAMBHANI")
        self.assertEqual(fields["date_of_birth"], "2003-09-17")
        self.assertEqual(fields["expiration_date"], "2027-09-17")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")

    def test_detects_state_id_when_ocr_inserts_noise_between_identification_and_card(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-17", "addressLine1": "1234 Main St", "city": "Austin", "state": "TX", "zip": "78701"}
        text = """
        Texas USA
        Texas STATE IDENTIFICATION 2 CARD The Lone Star State
        4d. ID MUMBER 12345678
        DOB NAME 09/17/2003 LAKSHYA BHAMBHANI
        ADDRESS 1234 MAIN ST AUSTIN, TX 78701
        4a. ISSUED 05/20/2024 4b. EXPIRES 05/20/2032
        """
        result = analyze_ocr_text(
            text,
            selected_document_type="state-id",
            document_side="front",
            profile=profile,
            request_id="req_texas_state_id",
        )

        self.assertEqual(detect_document_type(text), "state-id")
        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["last_name"], "BHAMBHANI")
        self.assertEqual(fields["date_of_birth"], "2003-09-17")
        self.assertEqual(fields["document_number"], "12345678")
        self.assertEqual(fields["address_line1"], "1234 MAIN ST")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")

    def test_extracts_texas_state_id_when_labels_precede_date_values(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-17", "addressLine1": "1234 Main St", "city": "Austin", "state": "TX", "zip": "78701"}
        result = analyze_ocr_text(
            """
            Texas USA ! Texase STATE IDENTIFICATION CARD The Lone Star State
            4d. ID NUMBER 12345678 3. DOB 1.NAME 09/17/2003 LAKSHYA BHAMBHANI
            8. ADDRESS 1234 MAIN ST AUSTIN, TX 78701
            5. SEX 16. HGT 18. EYES M 5'-10" BRO
            4a. ISSUED 4b. EXPIRES 05/20/2024 05/20/2032
            """,
            selected_document_type="state-id",
            document_side="front",
            profile=profile,
            request_id="req_texas_state_id_label_then_dates",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["last_name"], "BHAMBHANI")
        self.assertEqual(fields["date_of_birth"], "2003-09-17")
        self.assertEqual(fields["issue_date"], "2024-05-20")
        self.assertEqual(fields["expiration_date"], "2032-05-20")
        self.assertEqual(fields["document_number"], "12345678")
        self.assertEqual(fields["address_line1"], "1234 MAIN ST")
        self.assertEqual(fields["city"], "AUSTIN")
        self.assertEqual(fields["state"], "TX")
        self.assertEqual(fields["zip"], "78701")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")

    def test_extracts_texas_state_id_when_layout_number_precedes_address_label(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-15"}
        result = analyze_ocr_text(
            """
            Texas USA
            Texas STATE IDENTIFICATION CARD The Lone Star State 4d. ID NUMBER 12345678
            DOB NAME 09/17/2003 LAKSHYA BHAMBHANI
            8. ADDRESS 1234 MAIN ST AUSTIN, TX 78701
            4a, ISSUED 05/20/2024
            EXPIRES 05/20/2032
            """,
            selected_document_type="state-id",
            document_side="front",
            profile=profile,
            request_id="req_texas_state_id_address_marker",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["last_name"], "BHAMBHANI")
        self.assertEqual(fields["date_of_birth"], "2003-09-17")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MISMATCH")
        self.assertIn("date of birth does not match", result["userMessage"])

    def test_reports_combined_name_and_dob_mismatch_for_state_ids(self):
        result = analyze_ocr_text(
            """
            Texas STATE IDENTIFICATION CARD
            DOB NAME 09/17/2003 LAKSHYA BHAMBHANI
            8. ADDRESS 1234 MAIN ST AUSTIN, TX 78701
            4b. EXPIRES 05/20/2032
            """,
            selected_document_type="state-id",
            document_side="front",
            profile={**PROFILE, "legalLastName": "OTHER", "dateOfBirth": "2003-09-15"},
            request_id="req_state_id_name_dob_mismatch",
        )

        codes = [flag["code"] for flag in result["analysis"]["flags"]]
        self.assertIn("NAME_MISMATCH", codes)
        self.assertIn("DOB_MISMATCH", codes)
        self.assertIn("name and date of birth do not match", result["userMessage"])

    def test_extracts_new_york_state_id_with_spaced_ocr_header(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-17"}
        raw = (
            "NEw YORK STATE IDENTIFICATIO N C A R D LAKSHYA BHAMBANI 1 "
            "Sex M DOB 09/17/2003 ID Number Ua 0 ) 123 456 789 "
            "Address 1 123 ALBANY ST, NEW YORK, NY 10001 g "
            "Issued 10/26/2022 8 Wn Expires 09/17/2027 "
            "Micro-printed State Boundary Class NON-DRIVER &. Bhambani"
        )

        self.assertEqual(detect_document_type(raw), "state-id")

        result = analyze_ocr_text(
            raw,
            selected_document_type="state-id",
            document_side="front",
            profile=profile,
            request_id="req_ny_state_id",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["last_name"], "BHAMBANI")
        self.assertEqual(fields["date_of_birth"], "2003-09-17")
        self.assertEqual(fields["expiration_date"], "2027-09-17")
        self.assertEqual(result["analysis"]["validationResults"]["dobMatch"]["status"], "MATCH")
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MISMATCH",
            "BHAMBANI vs BHAMBHANI must be MISMATCH - exact matching required for identity verification")

    def test_extracts_new_york_state_id_exact_name_match(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-17"}
        result = analyze_ocr_text(
            "NEW YORK STATE IDENTIFICATION CARD LAKSHYA BHAMBHANI "
            "Sex M DOB 09/17/2003 ID Number 123456789 "
            "Issued 10/26/2022 Expires 09/17/2027",
            selected_document_type="state-id",
            document_side="front",
            profile=profile,
            request_id="req_ny_exact",
        )
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MATCH")
        self.assertTrue(result["analysis"]["complianceEligibility"])

    def test_exact_matching_rejects_single_letter_difference(self):
        result = analyze_ocr_text(
            "STATE IDENTIFICATION CARD LAKSHYA BHAMBANI Sex M DOB 09/17/2003 Expires 09/17/2027",
            selected_document_type="state-id",
            document_side="front",
            profile={**PROFILE, "dateOfBirth": "2003-09-17"},
            request_id="req_exact_mismatch",
        )
        self.assertEqual(result["analysis"]["validationResults"]["nameMatch"]["status"], "MISMATCH",
            "Single letter difference (BHAMBANI vs BHAMBHANI) must be caught - security requirement")

    def test_rejects_expired_driver_license(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-17"}
        result = analyze_ocr_text(
            """
            CALIFORNA DRIVER LICENSE
            BHAMBHANI LAKSHYA (LNIFN) DL No: B3456789
            DOB: 09/17/2003
            Issued: 10/12/2022 Expires: 09/17/2024
            """,
            selected_document_type="drivers-license",
            document_side="front",
            profile=profile,
            request_id="req_expired_dl",
        )

        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "EXPIRED")
        self.assertIn("DOCUMENT_EXPIRED", [flag["code"] for flag in result["analysis"]["flags"]])
        self.assertFalse(result["analysis"]["complianceEligibility"])

    def test_rejects_future_issue_date(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-17"}
        result = analyze_ocr_text(
            """
            CALIFORNA DRIVER LICENSE
            BHAMBHANI LAKSHYA (LNIFN) DL No: B3456789
            DOB: 09/17/2003
            Issued: 10/12/2099 Expires: 09/17/2128
            """,
            selected_document_type="drivers-license",
            document_side="front",
            profile=profile,
            request_id="req_future_issue_dl",
        )

        self.assertEqual(result["analysis"]["validationResults"]["expirationStatus"], "VALID")
        self.assertIn("ISSUE_DATE_IN_FUTURE", [flag["code"] for flag in result["analysis"]["flags"]])
        self.assertFalse(result["analysis"]["complianceEligibility"])

    def test_extracts_passport_label_layout_without_mrz(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-15"}
        result = analyze_ocr_text(
            """
            UNITED STATES OF AMERICA PASSPORT
            Passport No 123456789
            Surname Bhambhani
            Given Names Lakshya Kumar
            Date of Birth 09/15/2003
            Date of Expiration 04/15/2030
            """,
            selected_document_type="passport",
            document_side="front",
            profile=profile,
            request_id="req_passport_labels",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["last_name"], "BHAMBHANI")
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["middle_name"], "KUMAR")
        self.assertEqual(fields["date_of_birth"], "2003-09-15")
        self.assertEqual(fields["expiration_date"], "2030-04-15")

    def test_extracts_employment_authorization_layout(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-15"}
        result = analyze_ocr_text(
            """
            UNITED STATES OF AMERICA
            EMPLOYMENT AUTHORIZATION CARD
            Surname Bhambhani
            Given Name Lakshya
            USCIS# A123456789
            Date of Birth 09/15/2003
            Card Expires 04/15/2030
            Category C09
            """,
            selected_document_type="employment-authorization-card",
            document_side="front",
            profile=profile,
            request_id="req_ead",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["last_name"], "BHAMBHANI")
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["date_of_birth"], "2003-09-15")
        self.assertEqual(fields["expiration_date"], "2030-04-15")
        self.assertEqual(fields["category"], "C09")

    def test_extracts_military_id_name_layout(self):
        profile = {**PROFILE, "dateOfBirth": "2003-09-15"}
        result = analyze_ocr_text(
            """
            UNITED STATES ARMED FORCES
            COMMON ACCESS CARD
            NAME BHAMBHANI, LAKSHYA K
            DOD ID 1234567890
            DOB 09/15/2003
            EXPIRATION DATE 04/15/2030
            """,
            selected_document_type="military-id",
            document_side="front",
            profile=profile,
            request_id="req_military",
        )

        fields = result["analysis"]["extractedFields"]
        self.assertEqual(fields["last_name"], "BHAMBHANI")
        self.assertEqual(fields["first_name"], "LAKSHYA")
        self.assertEqual(fields["middle_name"], "K")
        self.assertEqual(fields["date_of_birth"], "2003-09-15")
        self.assertEqual(fields["document_number"], "1234567890")


if __name__ == "__main__":
    unittest.main()
