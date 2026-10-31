import XCTest

/// Focus-only checks against SAI: never sends a message, saves settings or starts a call.
final class KeyboardLayoutTests: XCTestCase {
    func testHeaderStaysPutAndComposerClearsKeyboard() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "dev.example.sai.mobile")
        app.launchArguments = ["--sai-keyboard-layout-probe"]
        #if targetEnvironment(simulator)
        app.launchArguments.append("--sai-keyboard-fixture")
        #endif
        app.launch()
        let talk = app.webViews.buttons["Talk with Samantha"]
        XCTAssertTrue(talk.waitForExistence(timeout: 40), app.debugDescription)
        let composer = app.webViews.textViews["Message Samantha"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let initialHeader = talk.frame
        XCTAssertGreaterThan(initialHeader.minY, 40, "Header must remain below the phone status bar")
        for _ in 0..<3 {
            composer.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            XCTAssertGreaterThan(app.keyboards.firstMatch.frame.height, 200, "This test requires the full software keyboard, not only a hardware-keyboard toolbar")
            XCTAssertEqual(talk.frame.minY, initialHeader.minY, accuracy: 1)
            XCTAssertEqual(talk.frame.maxY, initialHeader.maxY, accuracy: 1)
            XCTAssertLessThanOrEqual(composer.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
            let keyboardShot = XCTAttachment(screenshot: app.screenshot())
            keyboardShot.name = "Full keyboard with stable header"
            keyboardShot.lifetime = .keepAlways
            add(keyboardShot)
            // The name is inert. Tapping the header dismisses the keyboard, not a call action.
            app.webViews.staticTexts["Samantha"].firstMatch.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
            XCTAssertEqual(talk.frame.minY, initialHeader.minY, accuracy: 1)
        }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Header below status bar after keyboard cycles"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.webViews.buttons["Settings"].firstMatch.tap()
        let key = app.webViews.secureTextFields.firstMatch
        XCTAssertTrue(key.waitForExistence(timeout: 5))
        key.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(key.frame.minY, 40)
        XCTAssertLessThanOrEqual(key.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        app.webViews.buttons["Close settings"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        let saved = expectation(description: "Finish geometry recording")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { saved.fulfill() }
        wait(for: [saved], timeout: 2)
    }
}
