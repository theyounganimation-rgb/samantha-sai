import XCTest

/// Real WebKit and keyboard geometry, with read-only fixture data in the simulator.
final class IPadLayoutTests: XCTestCase {
    func testTabletRotationAndKeyboard() throws {
        #if targetEnvironment(simulator)
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "dev.example.sai.mobile")
        app.launchArguments = ["--sai-keyboard-layout-probe", "--sai-keyboard-fixture"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let talk = app.webViews.buttons["Talk with Samantha"]
        XCTAssertTrue(talk.waitForExistence(timeout: 40), app.debugDescription)
        let composer = app.webViews.textViews["Message Samantha"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        for orientation in [UIDeviceOrientation.portrait, .landscapeLeft, .landscapeRight, .portraitUpsideDown] {
            XCUIDevice.shared.orientation = orientation
            let settled = expectation(description: "Rotation settled")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { settled.fulfill() }
            wait(for: [settled], timeout: 2)
            let before = talk.frame
            XCTAssertGreaterThan(before.minY, 0, "Header must clear the status area")
            XCTAssertLessThanOrEqual(composer.frame.maxY, app.frame.maxY - 15)
            composer.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            XCTAssertGreaterThan(app.keyboards.firstMatch.frame.height, 200)
            XCTAssertEqual(talk.frame.minY, before.minY, accuracy: 1)
            XCTAssertLessThanOrEqual(composer.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "iPad keyboard orientation \(orientation.rawValue)"
            shot.lifetime = .keepAlways
            add(shot)
            app.webViews.staticTexts["Keyboard layout fixture 29"].tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        }
        XCUIDevice.shared.orientation = .portrait
        #else
        throw XCTSkip("This fixture test only runs in the simulator; it must not change live conversations.")
        #endif
    }
}
