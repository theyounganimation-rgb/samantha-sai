import XCTest
final class BackgroundCallTests: XCTestCase {
    func testMutedCallSurvivesSwitchingApps() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "dev.example.sai.mobile")
        app.launch()
        let talk = app.webViews.buttons["Talk with Samantha"]
        XCTAssertTrue(talk.waitForExistence(timeout: 40), app.debugDescription)
        talk.tap()
        let start = app.webViews.buttons["Talk to Samantha"]
        XCTAssertTrue(start.waitForExistence(timeout: 10)); start.tap()
        addUIInterruptionMonitor(withDescription: "Microphone permission") { alert in
            if alert.buttons["Allow"].exists { alert.buttons["Allow"].tap(); return true }
            if alert.buttons["OK"].exists { alert.buttons["OK"].tap(); return true }
            return false
        }
        let mute = app.webViews.buttons["Mute microphone"]
        XCTAssertTrue(mute.waitForExistence(timeout: 20), app.debugDescription)
        mute.tap()
        let unmute = app.webViews.buttons["Unmute microphone"]
        XCTAssertTrue(unmute.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts["Microphone muted"].waitForExistence(timeout: 25), app.debugDescription)
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        let wait = expectation(description: "Keep native call running in background")
        DispatchQueue.main.asyncAfter(deadline: .now() + 35) { wait.fulfill() }
        waitForExpectations(timeout: 40)
        app.activate()
        XCTAssertTrue(unmute.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.webViews.buttons["End call"].exists)
        unmute.tap()
        XCTAssertTrue(mute.waitForExistence(timeout: 10))
        app.webViews.buttons["End call"].tap()
        XCTAssertTrue(start.waitForExistence(timeout: 10))
    }
}
